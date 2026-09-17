# Lot B — Extensions Markdown : plan d'implémentation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ajouter notes de bas de page, admonitions, sommaire `[[toc]]` et légendes de figures numérotées à MD to PDF, sur des syntaxes portables, en séparant le moteur de rendu markdown de l'interface.

**Architecture:** Un module ES `renderer/markdown/` devient le seul endroit qui connaisse marked, KaTeX, highlight.js et les greffons. Il expose `parse(source) → html` (sans DOM, testable sous `node:test`) et `enhance(root) → { headings }` (passes DOM, testé sous Electron). `renderer/markdown-src.js` est l'entrée navigateur bundlée par esbuild qui pose `window.md`. `renderer.js` ne référence plus aucune bibliothèque directement.

**Tech Stack:** Electron 32, marked 14, marked-highlight, marked-katex-extension, marked-footnote 1.4, marked-alert 2.1, marked-directive 1.0, highlight.js, esbuild, `node:test`.

**Spec:** `docs/superpowers/specs/2026-09-17-markdown-extensions-design.md` (sur `main` — ce worktree est branché depuis `origin/main`, antérieur au commit du design)

## Global Constraints

- Libellés générés **en français, en dur** : `Sommaire`, `Figure`, `Notes`, `Note`, `Astuce`, `Important`, `Attention`, `Danger`.
- Syntaxes **portables** : `[^1]` pour les notes, `> [!NOTE]` comme syntaxe principale d'admonition (`:::note` accepté en second), `[[toc]]` pour le sommaire, aucune syntaxe nouvelle pour les figures.
- Une syntaxe non reconnue **dégrade**, elle ne casse jamais : un type d'admonition inconnu reste une citation, un appel de note orphelin reste du texte littéral.
- **mermaid reste chargé par balise `<script>`** — ne pas le mettre dans le bundle.
- Aucune ressource distante : la CSP du renderer est `default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:`. Les icônes doivent donc être du SVG inline, pas une police d'icônes ni une image distante.
- Les trois greffons exigent `marked >= 7.0.0`, satisfait par la version 14.1 installée.
- `git` doit être appelé via `/usr/bin/git` dans ce worktree : le hook RTK réécrit `git` en `rtk git`, que la garde d'isolation refuse.
- Toute commande shell doit être **simple** (pas de `cd x && y`, pas d'enchaînement complexe) : la garde d'isolation du worktree refuse ce qu'elle ne peut pas vérifier.

---

### Task 1: Extraire le moteur de rendu markdown

Refactor pur : aucune fonctionnalité ajoutée, comportement identique. C'est la frontière sur laquelle les six tâches suivantes s'appuient.

**Files:**
- Create: `renderer/markdown/labels.js`
- Create: `renderer/markdown/parse.js`
- Create: `renderer/markdown-src.js`
- Delete: `renderer/vendor-src.js`
- Create: `test/markdown.test.js`
- Modify: `renderer/index.html` (balises `<script>` de l'en-tête et du pied)
- Modify: `renderer/renderer.js` (lignes 1-15 : `setupMarked`, et `render()`)
- Modify: `package.json` (scripts `bundle` et `test`)
- Modify: `.gitignore`
- Modify: `test/smoke.js` (assertions de disponibilité des bibliothèques)

**Interfaces:**
- Consumes: rien.
- Produits pour les tâches suivantes :
  - `renderer/markdown/labels.js` → `export const LABELS` : `{ toc: string, figure: string, footnotes: string, alerts: Record<string,string> }`
  - `renderer/markdown/parse.js` → `export function createParser(): (source: string) => string`
  - `window.md.parse(source: string) → string` dans le renderer

- [ ] **Step 1: Écrire le test qui échoue**

Créer `test/markdown.test.js` :

```js
// Le moteur de rendu est un module ES ordinaire, sans DOM ni `window` : ces
// tests s'exécutent en quelques millisecondes, là où le test de fumée doit
// démarrer Electron.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createParser } from '../renderer/markdown/parse.js';

const parse = createParser();

test('les maths en bloc sont composées par KaTeX', () => {
  const html = parse('$$\\int_0^\\infty e^{-x^2} dx$$');
  assert.match(html, /katex-display/);
});

test('les maths en ligne sont composées par KaTeX', () => {
  const html = parse('Soit $E = mc^2$ la relation.');
  assert.match(html, /class="katex"/);
});

test('le code est coloré par highlight.js', () => {
  const html = parse('```js\nconst a = 1;\n```');
  assert.match(html, /hljs/);
});

test('les tableaux GFM sont rendus', () => {
  const html = parse('| a | b |\n|---|---|\n| 1 | 2 |');
  assert.match(html, /<table>/);
});

test('<!-- pagebreak --> devient un élément', () => {
  const html = parse('Avant\n\n<!-- pagebreak -->\n\nAprès');
  assert.match(html, /<div class="page-break"><\/div>/);
});
```

- [ ] **Step 2: Lancer le test et le voir échouer**

Run: `node --test test/markdown.test.js`
Expected: FAIL — `Cannot find module '../renderer/markdown/parse.js'`

- [ ] **Step 3: Créer `renderer/markdown/labels.js`**

```js
// Français, en dur : l'interface est en français et rien ici n'est
// configurable, par décision de cadrage.
export const LABELS = {
  toc: 'Sommaire',
  figure: 'Figure',
  footnotes: 'Notes',
  backref: 'Retour à l’appel {0}',
  alerts: {
    note: 'Note',
    tip: 'Astuce',
    important: 'Important',
    warning: 'Attention',
    caution: 'Danger',
  },
};
```

- [ ] **Step 4: Créer `renderer/markdown/parse.js`**

Reprendre la configuration actuelle de `renderer.js` (lignes 1-14) et la liste de langages de `renderer/vendor-src.js`, sans rien changer au comportement :

```js
// Le moteur de rendu markdown : tout ce qui transforme du texte source en HTML
// vit ici. Module ES sans DOM ni `window`, pour que `node --test` puisse
// l'exercer directement au lieu de démarrer Electron.
//
// highlight.js ne publie qu'un build CommonJS et un shim ESM qui le
// ré-exporte : un `<script type="module">` de navigateur récupère le shim puis
// explose sur `require`. C'est ce qui avait fait tomber l'enregistrement de
// KaTeX en v1.1.3. Le bundler règle le problème à la source.
//
// `common` couvre ~35 langages au lieu des 190 (1,0 Mo -> ~230 Ko) ; les
// suppléments ci-dessous sont ceux que cet éditeur croise vraiment.
import { Marked } from 'marked';
import { markedHighlight } from 'marked-highlight';
import markedKatex from 'marked-katex-extension';
import hljs from 'highlight.js/lib/common';

import dockerfile from 'highlight.js/lib/languages/dockerfile';
import powershell from 'highlight.js/lib/languages/powershell';
import dart from 'highlight.js/lib/languages/dart';
import nginx from 'highlight.js/lib/languages/nginx';
import apache from 'highlight.js/lib/languages/apache';
import scala from 'highlight.js/lib/languages/scala';
import elixir from 'highlight.js/lib/languages/elixir';
import haskell from 'highlight.js/lib/languages/haskell';
import fsharp from 'highlight.js/lib/languages/fsharp';
import lisp from 'highlight.js/lib/languages/lisp';

for (const [name, lang] of Object.entries({
  dockerfile, powershell, dart, nginx, apache, scala, elixir, haskell, fsharp, lisp,
})) hljs.registerLanguage(name, lang);

// `<!-- pagebreak -->` est invisible à l'écran mais doit survivre comme élément
// pour que la feuille d'export puisse y accrocher un `break-after`.
function preprocess(source) {
  return source.replace(/<!--\s*pagebreak\s*-->/gi, '<div class="page-break"></div>');
}

export function createParser() {
  const marked = new Marked();

  marked.use(markedHighlight({
    langPrefix: 'hljs language-',
    highlight(code, lang) {
      const language = hljs.getLanguage(lang) ? lang : 'plaintext';
      return hljs.highlight(code, { language, ignoreIllegals: true }).value;
    },
  }));

  marked.use(markedKatex({ throwOnError: false }));
  marked.use({ gfm: true, breaks: false });

  return (source) => marked.parse(preprocess(source));
}
```

- [ ] **Step 5: Lancer le test et le voir passer**

Run: `node --test test/markdown.test.js`
Expected: PASS — 5 tests

- [ ] **Step 6: Créer l'entrée navigateur `renderer/markdown-src.js`**

```js
// Entrée navigateur du moteur : bundlée par esbuild, elle se contente de lier
// le module au global. Toute la logique vit dans ./markdown/, faute de quoi les
// tests unitaires auraient besoin d'un `window` factice.
import { createParser } from './markdown/parse.js';

window.md = { parse: createParser() };
```

- [ ] **Step 7: Supprimer l'ancienne entrée**

```bash
/usr/bin/git rm renderer/vendor-src.js
```

- [ ] **Step 8: Mettre à jour `package.json`**

Remplacer les scripts `bundle` et `test` :

```json
"bundle": "esbuild renderer/editor-src.js --bundle --outfile=renderer/editor-bundle.js --format=iife --minify && esbuild renderer/markdown-src.js --bundle --outfile=renderer/markdown-bundle.js --format=iife --minify",
"test": "npm run bundle && node --test test/markdown.test.js && electron test/smoke.js",
```

Le chemin doit être explicite : `node --test test/` traiterait **tous** les fichiers du dossier `test/` comme des tests, y compris `smoke.js`, qui a besoin d'Electron et échouerait sous node.

- [ ] **Step 9: Mettre à jour `.gitignore`**

Remplacer la ligne `renderer/vendor-bundle.js` par `renderer/markdown-bundle.js`.

- [ ] **Step 10: Mettre à jour `renderer/index.html`**

Dans `<head>`, la feuille KaTeX reste (l'aperçu en a besoin), la feuille highlight.js aussi (elle est lue par les exports via `#hljs-theme`). En pied de page, remplacer le bloc de balises :

```html
  <script src="../node_modules/marked/marked.min.js"></script>
  <script src="../node_modules/marked-highlight/lib/index.umd.js"></script>
  <script src="../node_modules/katex/dist/katex.min.js"></script>
  <script src="../node_modules/marked-katex-extension/lib/index.umd.js"></script>
  <script src="../node_modules/mermaid/dist/mermaid.min.js"></script>
  <script src="vendor-bundle.js"></script>
  <script src="editor-bundle.js"></script>
  <script src="renderer.js"></script>
```

par :

```html
  <script src="../node_modules/mermaid/dist/mermaid.min.js"></script>
  <script src="markdown-bundle.js"></script>
  <script src="editor-bundle.js"></script>
  <script src="renderer.js"></script>
```

- [ ] **Step 11: Mettre à jour `renderer/renderer.js`**

Supprimer entièrement le bloc des lignes 1 à 15 (de `// ---------- Marked setup ----------` jusqu'à `setupMarked();` inclus). Le fichier commence désormais par la ligne mermaid :

```js
// ---------- Mermaid ----------
if (window.mermaid) mermaid.initialize({ startOnLoad: false, theme: 'default', securityLevel: 'strict' });
```

Dans `render()`, remplacer :

```js
  // `<!-- pagebreak -->` is invisible on screen but has to survive as an element
  // for the export stylesheet to hang a `break-after` on it.
  preview.innerHTML = marked.parse(body.replace(/<!--\s*pagebreak\s*-->/gi, '<div class="page-break"></div>'));
```

par :

```js
  preview.innerHTML = md.parse(body);
```

- [ ] **Step 12: Mettre à jour `test/smoke.js`**

Remplacer le bloc « libraries reached the renderer » :

```js
  const libs = await win.webContents.executeJavaScript(
    'JSON.stringify({hljs: typeof window.hljs, katex: typeof window.katex, katexExt: typeof window.markedKatex, mermaid: typeof window.mermaid, marked: typeof window.marked})'
  );
  const l = JSON.parse(libs);
  check('highlight.js is available', l.hljs === 'object', libs);
  check('KaTeX is available', l.katex === 'object', libs);
  check('marked-katex-extension is available', l.katexExt === 'function', libs);
  check('mermaid is available', l.mermaid === 'object', libs);
```

par :

```js
  const libs = await win.webContents.executeJavaScript(
    'JSON.stringify({parse: typeof window.md?.parse, mermaid: typeof window.mermaid})'
  );
  const l = JSON.parse(libs);
  check('the markdown engine is available', l.parse === 'function', libs);
  check('mermaid is available', l.mermaid === 'object', libs);
```

Puis remplacer les deux occurrences de `window.marked.parse(` par `window.md.parse(` dans le reste du fichier.

- [ ] **Step 13: Lancer la suite complète**

Run: `npm test`
Expected: 5 tests unitaires PASS, puis `14/14 checks passed` au test de fumée (les 16 précédents moins les deux assertions de bibliothèques fusionnées).

- [ ] **Step 14: Commit**

```bash
/usr/bin/git add -A
/usr/bin/git commit -m "refactor: extrait le moteur de rendu markdown de l'interface"
```

---

### Task 2: Notes de bas de page

**Files:**
- Modify: `package.json` (dépendance)
- Modify: `renderer/markdown/parse.js`
- Modify: `renderer/styles.css`
- Modify: `test/markdown.test.js`

**Interfaces:**
- Consumes: `createParser()` et `LABELS` de la tâche 1.
- Produces: le HTML `<section class="footnotes" data-footnotes>` avec `<h2 id="footnote-label">Notes</h2>`, consommé par la feuille de style de la tâche 7.

- [ ] **Step 1: Écrire les tests qui échouent**

Ajouter à `test/markdown.test.js` :

```js
test('un appel de note est lié à sa définition', () => {
  const html = parse('Texte[^1].\n\n[^1]: la note\n');
  assert.match(html, /<sup><a id="footnote-ref-1" href="#footnote-1"/);
  assert.match(html, /<section class="footnotes"/);
  assert.match(html, /la note/);
});

test('le bloc de notes porte un titre français', () => {
  const html = parse('Texte[^1].\n\n[^1]: la note\n');
  assert.match(html, /<h2 id="footnote-label">Notes<\/h2>/);
});

test('une définition jamais appelée n’est pas rendue', () => {
  const html = parse('Rien.\n\n[^9]: jamais appelée\n');
  assert.doesNotMatch(html, /jamais appelée/);
  assert.doesNotMatch(html, /footnotes/);
});

test('un appel sans définition reste littéral', () => {
  const html = parse('Texte[^2] sans définition.\n');
  assert.match(html, /Texte\[\^2\] sans définition/);
});
```

- [ ] **Step 2: Lancer les tests et les voir échouer**

Run: `node --test test/markdown.test.js`
Expected: FAIL sur les trois premiers — le HTML contient `Texte[^1].` littéral au lieu du `<sup>`.

- [ ] **Step 3: Installer le greffon**

```bash
npm install marked-footnote@^1.4.0
```

- [ ] **Step 4: Câbler le greffon dans `renderer/markdown/parse.js`**

Ajouter l'import en tête, après `markedKatex` :

```js
import markedFootnote from 'marked-footnote';
import { LABELS } from './labels.js';
```

Dans `createParser()`, avant `marked.use({ gfm: true, breaks: false })` :

```js
  // `headingClass: ''` retire la classe `sr-only` par défaut : le titre doit
  // être visible, c'est un document imprimé, pas une page web.
  marked.use(markedFootnote({
    description: LABELS.footnotes,
    headingClass: '',
    footnoteDivider: true,
    backRefLabel: LABELS.backref,
  }));
```

- [ ] **Step 5: Lancer les tests et les voir passer**

Run: `node --test test/markdown.test.js`
Expected: PASS — 9 tests

- [ ] **Step 6: Habiller le bloc de notes**

Ajouter à la fin de `renderer/styles.css` :

```css
/* ---------- Notes de bas de page ---------- */
#preview sup a[data-footnote-ref] {
  text-decoration: none;
  padding: 0 0.15em;
  font-weight: 600;
  color: var(--accent);
}
#preview .footnotes {
  font-size: 0.9em;
  color: var(--fg-muted);
}
#preview .footnotes h2 {
  font-size: 1em;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--fg-muted);
  border: 0;
}
#preview .footnotes ol {
  padding-left: 1.2em;
}
#preview .footnotes a[data-footnote-backref] {
  text-decoration: none;
  margin-left: 0.3em;
}
#preview hr[data-footnotes] {
  border: 0;
  border-top: 1px solid var(--border);
  margin-top: 2.5rem;
}
```

- [ ] **Step 7: Vérifier la suite complète**

Run: `npm test`
Expected: 9 tests unitaires PASS, `14/14 checks passed`

- [ ] **Step 8: Commit**

```bash
/usr/bin/git add -A
/usr/bin/git commit -m "feat: notes de bas de page"
```

---

### Task 3: Admonitions

**Files:**
- Modify: `package.json` (deux dépendances)
- Create: `renderer/markdown/icons.js`
- Modify: `renderer/markdown/parse.js`
- Modify: `renderer/styles.css`
- Modify: `test/markdown.test.js`

**Interfaces:**
- Consumes: `createParser()`, `LABELS.alerts` de la tâche 1.
- Produces: le HTML `<div class="markdown-alert markdown-alert-<type>"><p class="markdown-alert-title">…`, consommé par la feuille de style de la tâche 7.

- [ ] **Step 1: Écrire les tests qui échouent**

Ajouter à `test/markdown.test.js` :

```js
test('> [!NOTE] devient une admonition titrée en français', () => {
  const html = parse('> [!NOTE]\n> corps\n');
  assert.match(html, /<div class="markdown-alert markdown-alert-note">/);
  assert.match(html, /<p class="markdown-alert-title">.*Note<\/p>/s);
  assert.match(html, /corps/);
});

test('les cinq types portent leur titre français', () => {
  const attendus = [
    ['NOTE', 'Note'],
    ['TIP', 'Astuce'],
    ['IMPORTANT', 'Important'],
    ['WARNING', 'Attention'],
    ['CAUTION', 'Danger'],
  ];
  for (const [type, titre] of attendus) {
    const html = parse(`> [!${type}]\n> corps\n`);
    assert.match(html, new RegExp(`markdown-alert-${type.toLowerCase()}`), type);
    assert.match(html, new RegExp(`${titre}</p>`), type);
  }
});

test('chaque admonition porte une icône SVG en ligne', () => {
  const html = parse('> [!WARNING]\n> corps\n');
  assert.match(html, /<svg[^>]*viewBox="0 0 16 16"/);
});

test('un type inconnu reste une simple citation', () => {
  const html = parse('> [!BOGUS]\n> corps\n');
  assert.match(html, /<blockquote>/);
  assert.doesNotMatch(html, /markdown-alert/);
});

test(':::note produit la même admonition', () => {
  const html = parse(':::note\ncorps **gras**\n:::\n');
  assert.match(html, /<div class="markdown-alert markdown-alert-note">/);
  assert.match(html, /<strong>gras<\/strong>/);
});

test(':::inconnu ne produit pas d’admonition', () => {
  const html = parse(':::inconnu\ncorps\n:::\n');
  assert.doesNotMatch(html, /markdown-alert/);
});
```

- [ ] **Step 2: Lancer les tests et les voir échouer**

Run: `node --test test/markdown.test.js`
Expected: FAIL — `> [!NOTE]` produit aujourd'hui `<blockquote><p>[!NOTE]`

- [ ] **Step 3: Installer les greffons**

```bash
npm install marked-alert@^2.1.2 marked-directive@^1.0.7
```

- [ ] **Step 4: Créer `renderer/markdown/icons.js`**

SVG en ligne : la CSP interdit toute ressource distante, et une police d'icônes ne s'imprimerait pas de façon fiable. `currentColor` laisse la couleur au thème.

```js
const svg = (body) =>
  `<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" class="markdown-alert-icon">${body}</svg>`;

const bang = '<rect x="7.25" y="4.5" width="1.5" height="5" rx="0.75" fill="currentColor"/>'
  + '<circle cx="8" cy="11.5" r="1" fill="currentColor"/>';

export const ICONS = {
  // cercle + i
  note: svg('<circle cx="8" cy="8" r="7" fill="none" stroke="currentColor" stroke-width="1.5"/>'
    + '<circle cx="8" cy="4.5" r="1" fill="currentColor"/>'
    + '<rect x="7.25" y="6.5" width="1.5" height="5" rx="0.75" fill="currentColor"/>'),
  // ampoule
  tip: svg('<circle cx="8" cy="6.5" r="4.5" fill="none" stroke="currentColor" stroke-width="1.5"/>'
    + '<rect x="6" y="11" width="4" height="1.5" rx="0.75" fill="currentColor"/>'
    + '<rect x="6.5" y="13.5" width="3" height="1.5" rx="0.75" fill="currentColor"/>'),
  // bulle de dialogue
  important: svg('<rect x="1" y="2" width="14" height="10" rx="2" fill="none" stroke="currentColor" stroke-width="1.5"/>'
    + '<path d="M5 12 L5 15 L8 12 Z" fill="currentColor"/>'),
  // triangle + !
  warning: svg('<path d="M8 1.5 L15 14 L1 14 Z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/>'
    + '<rect x="7.25" y="6" width="1.5" height="4" rx="0.75" fill="currentColor"/>'
    + '<circle cx="8" cy="12" r="0.9" fill="currentColor"/>'),
  // octogone + !
  caution: svg('<path d="M5.2 1 H10.8 L15 5.2 V10.8 L10.8 15 H5.2 L1 10.8 V5.2 Z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/>'
    + bang),
};
```

- [ ] **Step 5: Câbler les greffons dans `renderer/markdown/parse.js`**

Ajouter les imports après `markedFootnote` :

```js
import markedAlert from 'marked-alert';
import { createDirectives } from 'marked-directive';
import { ICONS } from './icons.js';
```

Ajouter au-dessus de `createParser()` :

```js
const ALERT_TYPES = Object.keys(LABELS.alerts);

// `> [!NOTE]` est la syntaxe principale : native sur GitHub et Obsidian, et
// elle dégrade en simple citation partout ailleurs. `:::note` est accepté en
// second pour les documents venus d'un Docusaurus, et rend le même HTML.
const directiveAlerts = {
  level: 'container',
  marker: ':::',
  renderer(token) {
    const name = token.meta.name;
    if (!ALERT_TYPES.includes(name)) return false;
    return `<div class="markdown-alert markdown-alert-${name}">`
      + `<p class="markdown-alert-title">${ICONS[name]}${LABELS.alerts[name]}</p>`
      + this.parser.parse(token.tokens)
      + '</div>';
  },
};
```

Dans `createParser()`, après le bloc `markedFootnote` :

```js
  marked.use(markedAlert({
    variants: ALERT_TYPES.map(type => ({
      type,
      icon: ICONS[type],
      title: LABELS.alerts[type],
    })),
  }));

  marked.use(createDirectives([directiveAlerts]));
```

- [ ] **Step 6: Lancer les tests et les voir passer**

Run: `node --test test/markdown.test.js`
Expected: PASS — 15 tests

- [ ] **Step 7: Habiller les admonitions**

Ajouter à la fin de `renderer/styles.css` :

```css
/* ---------- Admonitions ---------- */
#preview .markdown-alert {
  border-left: 4px solid var(--alert-color);
  background: color-mix(in srgb, var(--alert-color) 8%, transparent);
  padding: 0.8rem 1rem;
  margin: 1.2rem 0;
  border-radius: 0 6px 6px 0;
  --alert-color: var(--accent);
}
#preview .markdown-alert > :first-child { margin-top: 0; }
#preview .markdown-alert > :last-child { margin-bottom: 0; }
#preview .markdown-alert-title {
  display: flex;
  align-items: center;
  gap: 0.45em;
  font-weight: 600;
  color: var(--alert-color);
  margin-bottom: 0.4rem;
}
#preview .markdown-alert-icon { flex: none; }

#preview .markdown-alert-note      { --alert-color: #2563eb; }
#preview .markdown-alert-tip       { --alert-color: #15803d; }
#preview .markdown-alert-important { --alert-color: #7c3aed; }
#preview .markdown-alert-warning   { --alert-color: #b45309; }
#preview .markdown-alert-caution   { --alert-color: #b91c1c; }

:root[data-theme="dark"] #preview .markdown-alert-note      { --alert-color: #60a5fa; }
:root[data-theme="dark"] #preview .markdown-alert-tip       { --alert-color: #4ade80; }
:root[data-theme="dark"] #preview .markdown-alert-important { --alert-color: #c084fc; }
:root[data-theme="dark"] #preview .markdown-alert-warning   { --alert-color: #fbbf24; }
:root[data-theme="dark"] #preview .markdown-alert-caution   { --alert-color: #f87171; }
```

- [ ] **Step 8: Vérifier la suite complète**

Run: `npm test`
Expected: 15 tests unitaires PASS, `14/14 checks passed`

- [ ] **Step 9: Commit**

```bash
/usr/bin/git add -A
/usr/bin/git commit -m "feat: admonitions GitHub et directives :::"
```

---

### Task 4: Passe DOM et identifiants de titres stables

**Files:**
- Create: `renderer/markdown/enhance.js`
- Modify: `renderer/markdown-src.js`
- Modify: `renderer/renderer.js` (`render()` et `buildToc()`)
- Modify: `test/smoke.js`

**Interfaces:**
- Consumes: `LABELS` de la tâche 1.
- Produces:
  - `export function enhance(root: Element): { headings: Array<{ id: string, text: string, level: number, el: Element }> }`
  - `window.md.enhance(root)` — appelé par `render()`
  - `buildToc(headings)` dans `renderer.js` prend désormais un argument

- [ ] **Step 1: Écrire le test qui échoue**

Ajouter à `test/smoke.js`, après le bloc `rendered` existant :

```js
  // Les identifiants positionnels (`h-0`, `h-1`) se décalent dès qu'un titre est
  // ajouté au-dessus : une ancre d'un HTML exporté cesse de désigner la même
  // section. Les slugs dérivés du texte sont stables.
  const slugs = await win.webContents.executeJavaScript(`(() => {
    const preview = document.getElementById('preview');
    preview.innerHTML = window.md.parse('# Mise en page\\n\\n## Notes\\n\\n## Notes\\n');
    const { headings } = window.md.enhance(preview);
    return JSON.stringify({
      ids: [...preview.querySelectorAll('h1,h2')].map(h => h.id),
      returned: headings.map(h => h.id + ':' + h.level),
    });
  })()`);
  const s = JSON.parse(slugs);
  check('les titres reçoivent des slugs stables', s.ids[0] === 'mise-en-page', slugs);
  check('les titres homonymes sont dédoublonnés', s.ids[1] === 'notes' && s.ids[2] === 'notes-2', slugs);
  check('enhance() retourne les titres avec leur niveau', s.returned[0] === 'mise-en-page:1', slugs);
```

- [ ] **Step 2: Lancer le test et le voir échouer**

Run: `npm test`
Expected: FAIL — `window.md.enhance is not a function`

- [ ] **Step 3: Créer `renderer/markdown/enhance.js`**

```js
// Passes qui s'exécutent après l'analyse : elles ont besoin d'un arbre rendu,
// donc elles vivent à part de l'analyseur et sont exercées par le test de fumée
// sous Electron plutôt que par `node --test`.
import { LABELS } from './labels.js';

export function enhance(root) {
  const headings = collectHeadings(root);
  return { headings };
}

// Les identifiants positionnels se décalent dès qu'un titre est inséré plus
// haut, ce qui casse les ancres d'un document exporté d'une fois sur l'autre.
// Les slugs dérivés du texte sont stables et suivent la convention GitHub.
function collectHeadings(root) {
  const used = new Map();
  return [...root.querySelectorAll('h1, h2, h3, h4, h5, h6')].map(el => {
    const text = el.textContent.trim();
    const base = slugify(text) || 'section';
    const seen = used.get(base) || 0;
    used.set(base, seen + 1);
    const id = seen ? `${base}-${seen + 1}` : base;
    el.id = id;
    return { id, text, level: Number(el.tagName[1]), el };
  });
}

function slugify(text) {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '');
}
```

- [ ] **Step 4: Exposer `enhance` dans `renderer/markdown-src.js`**

```js
// Entrée navigateur du moteur : bundlée par esbuild, elle se contente de lier
// le module au global. Toute la logique vit dans ./markdown/, faute de quoi les
// tests unitaires auraient besoin d'un `window` factice.
import { createParser } from './markdown/parse.js';
import { enhance } from './markdown/enhance.js';

window.md = { parse: createParser(), enhance };
```

- [ ] **Step 5: Câbler dans `renderer/renderer.js`**

Dans `render()`, remplacer :

```js
  preview.innerHTML = md.parse(body);
  resolveLocalImages();
```

par :

```js
  preview.innerHTML = md.parse(body);
  const { headings } = md.enhance(preview);
  resolveLocalImages();
```

et à la fin de `render()`, remplacer `buildToc();` par `buildToc(headings);`.

Remplacer `buildToc()` par :

```js
// Le panneau latéral consomme la liste produite par `enhance()` : les
// identifiants sont attribués une seule fois, sinon les deux sommaires
// divergeraient.
function buildToc(headings) {
  const toc = document.getElementById('toc');
  toc.innerHTML = '';
  for (const h of headings) {
    const a = document.createElement('a');
    a.href = '#' + h.id;
    a.textContent = h.text;
    a.className = h.el.tagName.toLowerCase();
    a.addEventListener('click', (e) => {
      e.preventDefault();
      const top = h.el.getBoundingClientRect().top - preview.getBoundingClientRect().top + preview.scrollTop - 8;
      preview.scrollTo({ top, behavior: 'smooth' });
    });
    toc.appendChild(a);
  }
}
```

- [ ] **Step 6: Lancer les tests et les voir passer**

Run: `npm test`
Expected: 15 tests unitaires PASS, `17/17 checks passed`

- [ ] **Step 7: Commit**

```bash
/usr/bin/git add -A
/usr/bin/git commit -m "refactor: identifiants de titres stables, passe DOM partagée"
```

---

### Task 5: Sommaire `[[toc]]`

**Files:**
- Modify: `renderer/markdown/enhance.js`
- Modify: `renderer/styles.css`
- Modify: `test/smoke.js`

**Interfaces:**
- Consumes: `collectHeadings()` et `LABELS.toc` de la tâche 4.
- Produces: `<nav class="md-toc">` dans le DOM de l'aperçu.

- [ ] **Step 1: Écrire les tests qui échouent**

Ajouter à `test/smoke.js`, après le bloc des slugs :

```js
  const toc = await win.webContents.executeJavaScript(`(() => {
    const preview = document.getElementById('preview');
    preview.innerHTML = window.md.parse('[[toc]]\\n\\n# Un\\n\\n## Deux\\n\\n#### Quatre\\n');
    window.md.enhance(preview);
    const nav = preview.querySelector('nav.md-toc');
    return JSON.stringify({
      present: !!nav,
      titre: nav ? nav.querySelector('.md-toc-title')?.textContent : null,
      liens: nav ? [...nav.querySelectorAll('a')].map(a => a.getAttribute('href')) : [],
    });
  })()`);
  const t = JSON.parse(toc);
  check('[[toc]] devient un sommaire', t.present, toc);
  check('le sommaire porte un titre français', t.titre === 'Sommaire', toc);
  check('le sommaire s’arrête au niveau 3', t.liens.length === 2 && t.liens[0] === '#un', toc);

  const tocVide = await win.webContents.executeJavaScript(`(() => {
    const preview = document.getElementById('preview');
    preview.innerHTML = window.md.parse('[[toc]]\\n\\nTexte sans titre.\\n');
    window.md.enhance(preview);
    return JSON.stringify({ nav: !!preview.querySelector('nav.md-toc'), reste: preview.textContent.includes('[[toc]]') });
  })()`);
  const tv = JSON.parse(tocVide);
  check('[[toc]] sans titre ne laisse pas d’encadré vide', !tv.nav && !tv.reste, tocVide);
```

- [ ] **Step 2: Lancer les tests et les voir échouer**

Run: `npm test`
Expected: FAIL — `[[toc]] devient un sommaire`, le marqueur reste du texte

- [ ] **Step 3: Implémenter dans `renderer/markdown/enhance.js`**

Dans `enhance()`, insérer l'appel :

```js
export function enhance(root) {
  const headings = collectHeadings(root);
  fillTableOfContents(root, headings);
  return { headings };
}
```

Ajouter la fonction :

```js
const TOC_MARKER = /^\[\[toc\]\]$/i;
const TOC_MAX_LEVEL = 3;

// Un paragraphe dont le contenu entier est `[[toc]]`. Le sommaire reprend les
// titres déjà collectés : une seule source, donc pas de divergence possible
// avec le panneau latéral.
function fillTableOfContents(root, headings) {
  const doc = root.ownerDocument;
  for (const p of [...root.querySelectorAll('p')]) {
    if (!TOC_MARKER.test(p.textContent.trim())) continue;
    const wanted = headings.filter(h => h.level <= TOC_MAX_LEVEL);
    if (!wanted.length) {
      p.remove();
      continue;
    }
    const nav = doc.createElement('nav');
    nav.className = 'md-toc';

    const title = doc.createElement('p');
    title.className = 'md-toc-title';
    title.textContent = LABELS.toc;
    nav.appendChild(title);

    const list = doc.createElement('ul');
    for (const h of wanted) {
      const li = doc.createElement('li');
      li.className = 'md-toc-h' + h.level;
      const a = doc.createElement('a');
      a.href = '#' + h.id;
      a.textContent = h.text;
      li.appendChild(a);
      list.appendChild(li);
    }
    nav.appendChild(list);
    p.replaceWith(nav);
  }
}
```

- [ ] **Step 4: Lancer les tests et les voir passer**

Run: `npm test`
Expected: `22/22 checks passed`

- [ ] **Step 5: Habiller le sommaire**

Ajouter à la fin de `renderer/styles.css` :

```css
/* ---------- Sommaire [[toc]] ---------- */
#preview .md-toc {
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 0.9rem 1.2rem;
  margin: 1.5rem 0;
  background: var(--bg-alt);
}
#preview .md-toc-title {
  margin: 0 0 0.5rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  font-size: 0.8em;
  color: var(--fg-muted);
}
#preview .md-toc ul {
  list-style: none;
  margin: 0;
  padding: 0;
}
#preview .md-toc li { margin: 0.15rem 0; }
#preview .md-toc-h2 { padding-left: 1.1rem; }
#preview .md-toc-h3 { padding-left: 2.2rem; }
#preview .md-toc a { text-decoration: none; }
#preview .md-toc a:hover { text-decoration: underline; }
```

- [ ] **Step 6: Vérifier**

Run: `npm test`
Expected: `22/22 checks passed`

- [ ] **Step 7: Commit**

```bash
/usr/bin/git add -A
/usr/bin/git commit -m "feat: sommaire [[toc]] inséré dans le document"
```

---

### Task 6: Légendes de figures

**Files:**
- Modify: `renderer/markdown/enhance.js`
- Modify: `renderer/styles.css`
- Modify: `test/smoke.js`

**Interfaces:**
- Consumes: `LABELS.figure` de la tâche 1, `enhance()` de la tâche 4.
- Produces: `<figure><img><figcaption>Figure N — …</figcaption></figure>`.

- [ ] **Step 1: Écrire les tests qui échouent**

Ajouter à `test/smoke.js`, après les blocs du sommaire :

```js
  const figures = await win.webContents.executeJavaScript(`(() => {
    const preview = document.getElementById('preview');
    preview.innerHTML = window.md.parse(
      '![Le schéma](a.png)\\n\\n![](b.png)\\n\\n![La copie](c.png)\\n\\n[![Lien](d.png)](https://exemple.fr)\\n'
    );
    window.md.enhance(preview);
    return JSON.stringify({
      legendes: [...preview.querySelectorAll('figcaption')].map(f => f.textContent),
      figures: preview.querySelectorAll('figure').length,
      lienIntact: !!preview.querySelector('a > img'),
      lienPasEnFigure: !preview.querySelector('figure > a'),
    });
  })()`);
  const f = JSON.parse(figures);
  check('les figures sont numérotées dans l’ordre',
    f.legendes[0] === 'Figure 1 — Le schéma' && f.legendes[1] === 'Figure 2 — La copie', figures);
  check('une image sans texte alternatif n’est pas numérotée', f.legendes.length === 2 && f.figures === 3, figures);
  check('une image cliquable reste un lien', f.lienIntact && f.lienPasEnFigure, figures);
```

- [ ] **Step 2: Lancer les tests et les voir échouer**

Run: `npm test`
Expected: FAIL — aucun `figcaption` dans le document

- [ ] **Step 3: Implémenter dans `renderer/markdown/enhance.js`**

Dans `enhance()`, ajouter l'appel :

```js
export function enhance(root) {
  const headings = collectHeadings(root);
  fillTableOfContents(root, headings);
  numberFigures(root);
  return { headings };
}
```

Ajouter la fonction :

```js
// Aucune syntaxe nouvelle : un paragraphe dont l'unique contenu est une image
// devient une figure. Une image sans texte alternatif ne reçoit ni légende ni
// numéro — une image décorative ne doit pas consommer un numéro de figure —
// mais reste dans un <figure> pour bénéficier des règles de saut de page.
function numberFigures(root) {
  const doc = root.ownerDocument;
  let n = 0;
  for (const p of [...root.querySelectorAll('p')]) {
    const content = [...p.childNodes].filter(
      node => node.nodeType !== node.TEXT_NODE || node.textContent.trim()
    );
    if (content.length !== 1) continue;
    const img = content[0];
    if (img.tagName !== 'IMG') continue;

    const figure = doc.createElement('figure');
    p.replaceWith(figure);
    figure.appendChild(img);

    const alt = (img.getAttribute('alt') || '').trim();
    if (!alt) continue;

    n += 1;
    const caption = doc.createElement('figcaption');
    caption.textContent = `${LABELS.figure} ${n} — ${alt}`;
    figure.appendChild(caption);
  }
}
```

- [ ] **Step 4: Lancer les tests et les voir passer**

Run: `npm test`
Expected: `25/25 checks passed`

- [ ] **Step 5: Habiller les figures**

Ajouter à la fin de `renderer/styles.css` :

```css
/* ---------- Figures ---------- */
#preview figure {
  margin: 1.5rem 0;
  text-align: center;
}
#preview figure img {
  max-width: 100%;
  border-radius: 6px;
}
#preview figcaption {
  margin-top: 0.5rem;
  font-size: 0.88em;
  color: var(--fg-muted);
  font-style: italic;
}
```

- [ ] **Step 6: Vérifier**

Run: `npm test`
Expected: `25/25 checks passed`

- [ ] **Step 7: Commit**

```bash
/usr/bin/git add -A
/usr/bin/git commit -m "feat: légendes de figures numérotées"
```

---

### Task 7: Pagination et survie dans les exports

Les quatre fonctionnalités doivent arriver intactes dans le PDF, l'impression et le HTML — c'est la raison d'être de l'application, et rien ne le vérifie encore.

**Files:**
- Modify: `renderer/renderer.js` (`paginationCss()`)
- Modify: `test/smoke.js`

**Interfaces:**
- Consumes: le HTML produit par les tâches 2, 3, 5 et 6.
- Produces: rien pour les tâches suivantes.

- [ ] **Step 1: Écrire le test qui échoue**

`paginationCss()` est une déclaration de fonction au premier niveau d'un script
classique : elle est donc accessible depuis le test via `window`. C'est elle qui
porte la partie RED de cette tâche ; les quatre vérifications de survie qui
suivent sont des garde-fous de non-régression, pas des moteurs TDD, et passent
dès l'écriture — elles échoueraient si une passe DOM n'était appliquée qu'à
l'écran.

Ajouter à `test/smoke.js`, juste avant le bloc « the PDF really embeds the KaTeX fonts » :

```js
  const pagination = await win.webContents.executeJavaScript(
    'JSON.stringify(window.paginationCss({}))'
  );
  const css = JSON.parse(pagination);
  check('la pagination protège les admonitions', css.includes('.markdown-alert'), css.slice(0, 200));
  check('la pagination protège les sommaires et les notes',
    css.includes('.md-toc') && css.includes('.footnotes'), css.slice(0, 200));

  // Les exports reprennent le DOM de l'aperçu : ce test échouerait si une passe
  // DOM n'était appliquée que pour l'écran.
  const exporte = await win.webContents.executeJavaScript(`(() => {
    const preview = document.getElementById('preview');
    preview.innerHTML = window.md.parse(
      '[[toc]]\\n\\n# Titre\\n\\n> [!WARNING]\\n> danger\\n\\n![Le schéma](a.png)\\n\\nTexte[^1].\\n\\n[^1]: la note\\n'
    );
    window.md.enhance(preview);
    const html = preview.innerHTML;
    return JSON.stringify({
      toc: html.includes('md-toc'),
      alerte: html.includes('markdown-alert-warning'),
      figure: html.includes('Figure 1'),
      note: html.includes('footnotes'),
    });
  })()`);
  const ex = JSON.parse(exporte);
  check('le sommaire survit dans le HTML imprimable', ex.toc, exporte);
  check('les admonitions survivent dans le HTML imprimable', ex.alerte, exporte);
  check('les légendes survivent dans le HTML imprimable', ex.figure, exporte);
  check('les notes survivent dans le HTML imprimable', ex.note, exporte);
```

- [ ] **Step 2: Lancer les tests et les voir échouer**

Run: `npm test`
Expected: FAIL sur `la pagination protège les admonitions` et `la pagination protège les sommaires et les notes` — `paginationCss()` ne connaît pas encore ces sélecteurs. Les quatre vérifications de survie passent déjà.

- [ ] **Step 3: Ajouter les règles de pagination**

Dans `renderer/renderer.js`, fonction `paginationCss()`, remplacer :

```js
    table, pre, blockquote, figure, img, .mermaid, .katex-display { break-inside: avoid; }
```

par :

```js
    table, pre, blockquote, figure, img, .mermaid, .katex-display { break-inside: avoid; }
    .markdown-alert, .md-toc { break-inside: avoid; }
    .footnotes { break-before: auto; }
    .footnotes h2 { break-after: avoid; }
```

- [ ] **Step 4: Lancer la suite complète**

Run: `npm test`
Expected: 15 tests unitaires PASS, `31/31 checks passed`

- [ ] **Step 5: Commit**

```bash
/usr/bin/git add -A
/usr/bin/git commit -m "feat: pagination des admonitions, sommaires et notes"
```

---

### Task 8: Documentation, document d'accueil et version

**Files:**
- Modify: `README.md`
- Modify: `renderer/renderer.js` (document d'accueil)
- Modify: `package.json` (version)

**Interfaces:**
- Consumes: tout ce qui précède.
- Produces: rien.

- [ ] **Step 1: Montrer les nouveautés dans le document d'accueil**

Le document d'accueil est un **littéral de gabarit JavaScript** dans
`renderer/renderer.js` : chaque accent grave du markdown doit y être échappé en
`\``, sinon le littéral se referme et le fichier ne compile plus.

Il se termine par une section « Diagramme ». Insérer avant cette section :

```js
## Notes et encadrés

Une affirmation qui mérite une source[^1].

[^1]: La source en question.

> [!TIP]
> \`> [!NOTE]\`, \`[!TIP]\`, \`[!IMPORTANT]\`, \`[!WARNING]\` et \`[!CAUTION]\`
> produisent un encadré. La syntaxe \`:::note\` marche aussi.

> [!WARNING]
> Insère \`[[toc]]\` où tu veux un sommaire, et une image seule sur sa
> ligne devient une figure numérotée.
```

- [ ] **Step 2: Vérifier à l'œil dans l'application**

Run: `npm start`
Expected: le document d'accueil affiche une note de bas de page cliquable, deux encadrés colorés avec icône, et les maths et diagrammes toujours en place. Fermer l'application.

- [ ] **Step 3: Documenter dans le README**

Dans la section « Aperçu », après la ligne des diagrammes Mermaid, ajouter :

```markdown
- **Notes de bas de page** (`Texte[^1]` + `[^1]: la note`), rejetées en fin de document
- **Encadrés** `> [!NOTE]`, `[!TIP]`, `[!IMPORTANT]`, `[!WARNING]`, `[!CAUTION]` — syntaxe GitHub et Obsidian, `:::note` également accepté
- **Sommaire** inséré dans le corps du document avec `[[toc]]` (titres 1 à 3)
- **Figures numérotées** : une image seule sur sa ligne devient une figure légendée par son texte alternatif
- **Ancres stables** : les titres reçoivent un identifiant dérivé de leur texte, pas de leur position
```

Dans la section « Architecture », remplacer les deux lignes `vendor-src.js` / `vendor-bundle.js` par :

```markdown
│   ├── markdown/               # Moteur de rendu : parse.js, enhance.js, labels.js, icons.js
│   ├── markdown-src.js         # Entrée navigateur du moteur (bundlée par esbuild)
│   ├── markdown-bundle.js      # Bundle généré (ignoré par git)
```

Dans la table des scripts npm, remplacer la ligne `npm test` par :

```markdown
| `npm test` | Tests unitaires du moteur (`node --test`, sans Electron) puis test de fumée end-to-end |
```

- [ ] **Step 4: Passer la version à 1.3.0**

Dans `package.json`, remplacer `"version": "1.2.1"` par `"version": "1.3.0"`.

- [ ] **Step 5: Lancer la suite complète une dernière fois**

Run: `npm test`
Expected: 15 tests unitaires PASS, `31/31 checks passed`

- [ ] **Step 6: Commit**

```bash
/usr/bin/git add -A
/usr/bin/git commit -m "docs: documente les extensions Markdown, version 1.3.0"
```
