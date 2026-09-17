# Lot A — Chaîne PDF : plan d'implémentation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Donner au PDF exporté des signets navigables, un sommaire avec numéros de page exacts, une page de garde et un filigrane.

**Architecture:** Un module CommonJS `pdf.js` à la racine porte tout ce qui est calculable sans Electron — les options de rendu, la lecture de la table des destinations d'un PDF, le remplissage des numéros de page — et devient testable sous `node:test`. `main.js` l'utilise pour un export en deux passes : rendre, lire sur quelle page chaque titre a atterri, remplir, rendre à nouveau. La page de garde et le filigrane vivent dans `buildPrintableHtml()` côté aperçu.

**Tech Stack:** Electron 32, `node:test`, aucune dépendance nouvelle.

**Spec:** `docs/superpowers/specs/2026-09-17-chaine-pdf-design.md`

## Global Constraints

- **Aucune dépendance nouvelle.** La lecture du PDF se fait à la main : Chromium n'émet pas de flux d'objets ici, les objets sont en clair.
- `generateDocumentOutline` **ne produit rien sans** `generateTaggedPDF` — mesuré. Les deux vont toujours ensemble.
- Ne jamais déduire un numéro de page depuis `offsetTop` : mesuré faux dès qu'une règle de pagination déplace un élément.
- Les slugs de titres conservent les accents, et le PDF les encode en échappements `#XX` dans ses noms de destination. Tout lecteur de la table doit les décoder.
- `pdf.js` est du CommonJS (`module.exports`), comme `main.js` et `preload.js`. Il ne référence ni Electron, ni DOM, ni `window`.
- Libellés générés en français, en dur.
- La CSP du renderer interdit toute ressource distante.
- Appelle git par son chemin absolu `/usr/bin/git` : un hook réécrit `git` en `rtk git`, que la garde d'isolation du worktree refuse.
- Chaque commande shell doit être **simple** : une commande par appel, pas de `cd x && y`.
- Les 17 tests unitaires et les 39 vérifications de fumée existants doivent rester verts. Tout nouveau bloc de `test/smoke.js` qui réécrit `preview.innerHTML` s'ajoute à la FIN du fichier, juste avant `const failed = results.filter(...)` : placé plus haut, il casse les vérifications de polices KaTeX.

---

### Task 1: Module PDF, signets et liens internes

**Files:**
- Create: `pdf.js`
- Create: `test/pdf.test.js`
- Modify: `main.js` (handler `file:export-pdf`)
- Modify: `package.json` (script `test`)
- Modify: `test/smoke.js`

**Interfaces:**
- Consumes: rien.
- Produces:
  - `pdf.js` → `module.exports = { pdfOptions, destinationPages, fillTocPages, decodePdfName }`
  - `pdfOptions(options) → object` : les options passées à `printToPDF`
  - `destinationPages(buffer) → { [slug]: pageNumber }`
  - `fillTocPages(html, pages) → html` (utilisé en tâche 2)
  - `decodePdfName(name) → string`

- [ ] **Step 1: Écrire les tests qui échouent**

Créer `test/pdf.test.js` :

```js
// Ce module est du CommonJS sans Electron ni DOM : `node --test` l'exerce
// directement, là où le test de fumée doit démarrer un navigateur.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { pdfOptions, destinationPages, fillTocPages, decodePdfName } = require('../pdf.js');

test('les signets exigent aussi le PDF balisé', () => {
  // Mesuré sur Electron 32 : generateDocumentOutline seul ne produit aucun
  // signet. Les deux options ne se séparent pas.
  const o = pdfOptions({});
  assert.equal(o.generateDocumentOutline, true);
  assert.equal(o.generateTaggedPDF, true);
});

test('les options de mise en page sont reprises', () => {
  const o = pdfOptions({ pageSize: 'Letter', landscape: true, margin: 0.25, headerFooter: true, headerText: 'Titre' });
  assert.equal(o.pageSize, 'Letter');
  assert.equal(o.landscape, true);
  assert.deepEqual(o.margins, { top: 0.25, bottom: 0.25, left: 0.25, right: 0.25 });
  assert.equal(o.displayHeaderFooter, true);
  assert.match(o.headerTemplate, /Titre/);
});

test('les marges ont une valeur par défaut', () => {
  assert.deepEqual(pdfOptions({}).margins, { top: 0.5, bottom: 0.5, left: 0.5, right: 0.5 });
});

test('un nom PDF échappé redonne ses accents', () => {
  // Les slugs gardent les accents ; le PDF les encode octet par octet.
  assert.equal(decodePdfName('p#c3#a9rim#c3#a8tre'), 'périmètre');
  assert.equal(decodePdfName('mise-en-page'), 'mise-en-page');
});

test('la table des destinations donne la page de chaque ancre', () => {
  const pdf = [
    '%PDF-1.7',
    '2 0 obj<</Type /Page /Parent 1 0 R>>endobj',
    '11 0 obj<</Type /Page /Parent 1 0 R>>endobj',
    '14 0 obj<</Type /Page /Parent 1 0 R>>endobj',
    '17 0 obj<</un [2 0 R /XYZ 0 0 0] /deux [11 0 R /XYZ 0 0 0] /p#c3#a9rim#c3#a8tre [14 0 R /XYZ 0 0 0]>>endobj',
    '20 0 obj<</Type /Catalog /Dests 17 0 R>>endobj',
  ].join('\n');
  assert.deepEqual(destinationPages(Buffer.from(pdf, 'latin1')), {
    un: 1, deux: 2, 'périmètre': 3,
  });
});

test('un PDF sans destinations ne fait pas échouer la lecture', () => {
  assert.deepEqual(destinationPages(Buffer.from('%PDF-1.7\n2 0 obj<</Type /Page>>endobj', 'latin1')), {});
});

test('les emplacements du sommaire reçoivent leur numéro', () => {
  const html = '<span class="md-toc-page" data-target="un"></span>'
    + '<span class="md-toc-page" data-target="absent"></span>';
  const out = fillTocPages(html, { un: 4 });
  assert.match(out, /data-target="un">4<\/span>/);
  assert.match(out, /data-target="absent"><\/span>/);
});
```

- [ ] **Step 2: Lancer le test et le voir échouer**

Run: `node --test test/pdf.test.js`
Expected: FAIL — `Cannot find module '../pdf.js'`

- [ ] **Step 3: Créer `pdf.js`**

```js
// Tout ce que la chaîne PDF sait calculer sans Electron. Isolé ici pour être
// exerçable par `node --test` : le reste de l'export a besoin d'un navigateur.

// Mesuré sur Electron 32 : `generateDocumentOutline` seul ne produit aucun
// signet, il lui faut l'arbre de structure du PDF balisé. Les deux ne se
// séparent pas. Le balisage rend au passage le PDF accessible.
function pdfOptions(options = {}) {
  const m = options.margin ?? 0.5;
  return {
    printBackground: true,
    pageSize: options.pageSize || 'A4',
    landscape: !!options.landscape,
    margins: { top: m, bottom: m, left: m, right: m },
    displayHeaderFooter: !!options.headerFooter,
    headerTemplate: '<div style="font-size:8px;width:100%;text-align:center;color:#666;">' + (options.headerText || '') + '</div>',
    footerTemplate: '<div style="font-size:8px;width:100%;text-align:center;color:#666;"><span class="pageNumber"></span> / <span class="totalPages"></span></div>',
    generateDocumentOutline: true,
    generateTaggedPDF: true,
  };
}

// Un nom PDF échappe hors de l'ASCII imprimable en `#XX`, octet par octet. Nos
// slugs gardent leurs accents, donc `périmètre` revient en `p#c3#a9rim#c3#a8tre`.
function decodePdfName(name) {
  const bytes = [];
  for (let i = 0; i < name.length; i++) {
    if (name[i] === '#' && /^[0-9a-f]{2}$/i.test(name.slice(i + 1, i + 3))) {
      bytes.push(parseInt(name.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      bytes.push(name.charCodeAt(i));
    }
  }
  return Buffer.from(bytes).toString('utf8');
}

// Chromium nomme ses destinations d'après les identifiants d'ancre du document
// et n'emploie pas de flux d'objets : la table est lisible telle quelle. Rendre
// un objet vide plutôt que lever, pour qu'un changement de Chromium coûte des
// numéros de page absents et non un export en échec.
function destinationPages(pdfBuffer) {
  const raw = Buffer.isBuffer(pdfBuffer) ? pdfBuffer.toString('latin1') : String(pdfBuffer);

  const pageOrder = [...raw.matchAll(/(\d+) 0 obj\s*<<[^>]*?\/Type\s*\/Page[^s]/g)].map(m => Number(m[1]));
  if (!pageOrder.length) return {};

  const ref = raw.match(/\/Dests\s+(\d+) 0 R/);
  if (!ref) return {};

  const obj = raw.match(new RegExp('(?:^|[^0-9])' + ref[1] + ' 0 obj([\\s\\S]*?)endobj'));
  if (!obj) return {};

  const pages = {};
  for (const m of obj[1].matchAll(/\/([^\s/[\]()<>]+)\s*\[\s*(\d+) 0 R/g)) {
    const page = pageOrder.indexOf(Number(m[2])) + 1;
    if (page > 0) pages[decodePdfName(m[1])] = page;
  }
  return pages;
}

// Les emplacements sont émis vides par l'aperçu : seul le PDF connaît les pages.
function fillTocPages(html, pages) {
  return html.replace(
    /<span class="md-toc-page" data-target="([^"]+)"><\/span>/g,
    (whole, target) => (pages[target]
      ? `<span class="md-toc-page" data-target="${target}">${pages[target]}</span>`
      : whole),
  );
}

module.exports = { pdfOptions, destinationPages, fillTocPages, decodePdfName };
```

- [ ] **Step 4: Lancer le test et le voir passer**

Run: `node --test test/pdf.test.js`
Expected: PASS — 7 tests

- [ ] **Step 5: Câbler `pdfOptions` dans `main.js`**

En tête de `main.js`, après les autres `require`, ajouter :

```js
const { pdfOptions, destinationPages, fillTocPages } = require('./pdf.js');
```

Dans le handler `file:export-pdf`, remplacer le bloc :

```js
  const m = options?.margin ?? 0.5;
  const buffer = await pdfWin.webContents.printToPDF({
    printBackground: true,
    pageSize: options?.pageSize || 'A4',
    landscape: !!options?.landscape,
    margins: { top: m, bottom: m, left: m, right: m },
    displayHeaderFooter: !!options?.headerFooter,
    headerTemplate: '<div style="font-size:8px;width:100%;text-align:center;color:#666;">' + (options?.headerText || '') + '</div>',
    footerTemplate: '<div style="font-size:8px;width:100%;text-align:center;color:#666;"><span class="pageNumber"></span> / <span class="totalPages"></span></div>',
  });
```

par :

```js
  const buffer = await pdfWin.webContents.printToPDF(pdfOptions(options));
```

Ne touche pas au handler `file:print` : il appelle `webContents.print()`, qui ne prend pas ces options.

- [ ] **Step 6: Mettre à jour le script de test**

Dans `package.json`, le script `test` devient :

```json
"test": "npm run bundle && node --test test/markdown.test.js test/pdf.test.js && electron test/smoke.js",
```

- [ ] **Step 7: Vérifier les signets et les liens sur un vrai PDF**

Dans `test/smoke.js`, la section qui produit déjà un PDF (`printToPDF`) écrit dans `pdf`. Ajouter juste après la vérification `KaTeX fonts are embedded in the PDF` :

```js
  // Les signets et les liens internes ne se lisent que dans le PDF produit.
  const { destinationPages } = require(path.join(root, 'pdf.js'));
  const withLinks = await pdfWin.webContents.executeJavaScript(`(() => {
    document.body.innerHTML = '<nav><a href="#un">un</a> <a href="#deux">deux</a></nav>'
      + '<h1 id="un">Un</h1><p style="height:1200px">a</p>'
      + '<h1 id="deux">Deux</h1><p style="height:1200px">b</p>';
    return true;
  })()`);
  const linked = await pdfWin.webContents.printToPDF({
    printBackground: true, pageSize: 'A4',
    margins: { top: 0.5, bottom: 0.5, left: 0.5, right: 0.5 },
    generateDocumentOutline: true, generateTaggedPDF: true,
  });
  const raw = linked.toString('latin1');
  check('le PDF porte des signets', /\/Outlines/.test(raw), 'withLinks=' + withLinks);
  check('les liens internes deviennent des annotations', /\/Subtype\s*\/Link/.test(raw));
  const destPages = destinationPages(linked);
  check('chaque ancre est résolue à sa page', destPages.un === 1 && destPages.deux >= 2, JSON.stringify(destPages));
```

- [ ] **Step 8: Lancer la suite complète**

Run: `npm test`
Expected: 24 tests unitaires PASS (17 + 7), `42/42 checks passed` (39 + 3)

- [ ] **Step 9: Commit**

```bash
/usr/bin/git add -A
/usr/bin/git commit -m "feat: signets PDF et module de lecture des destinations"
```

---

### Task 2: Sommaire avec numéros de page

**Files:**
- Modify: `renderer/markdown/enhance.js` (`fillTableOfContents`)
- Modify: `renderer/styles.css`
- Modify: `main.js` (handler `file:export-pdf`)
- Modify: `test/smoke.js`

**Interfaces:**
- Consumes: `destinationPages()` et `fillTocPages()` de la tâche 1.
- Produces: `<span class="md-toc-page" data-target="<slug>"></span>` dans chaque entrée de sommaire.

- [ ] **Step 1: Écrire les tests qui échouent**

Ajouter à la FIN de `test/smoke.js`, juste avant `const failed = results.filter(...)` :

```js
  const tocSlots = await win.webContents.executeJavaScript(`(() => {
    const preview = document.getElementById('preview');
    preview.innerHTML = window.md.parse('[[toc]]\\n\\n# Premier\\n\\n## Deuxième\\n');
    window.md.enhance(preview);
    const slots = [...preview.querySelectorAll('.md-toc-page')];
    return JSON.stringify({
      nombre: slots.length,
      cibles: slots.map(s => s.dataset.target),
      vides: slots.every(s => s.textContent === ''),
      html: preview.querySelector('.md-toc li').innerHTML,
    });
  })()`);
  const ts = JSON.parse(tocSlots);
  check('chaque entrée de sommaire porte un emplacement de page', ts.nombre === 2, tocSlots);
  check('l’emplacement vise l’ancre du titre', ts.cibles[0] === 'premier', tocSlots);
  check('l’emplacement est vide à l’écran', ts.vides, tocSlots);
  check('l’emplacement a la forme attendue par le remplissage',
    /<span class="md-toc-page" data-target="premier"><\/span>/.test(ts.html), ts.html);
```

La dernière vérification est la plus importante : le remplissage côté processus
principal est une substitution de chaîne, donc l'ordre des attributs produit par
le DOM fait partie du contrat.

- [ ] **Step 2: Lancer les tests et les voir échouer**

Run: `npm test`
Expected: FAIL sur les quatre — aucun `.md-toc-page` dans le document

- [ ] **Step 3: Émettre les emplacements dans `enhance.js`**

Dans `fillTableOfContents`, après `li.appendChild(a);`, ajouter :

```js
      // Emplacement vide : seul le PDF sait sur quelle page le titre atterrit.
      // L'ordre d'écriture des attributs fait partie du contrat — le processus
      // principal les remplit par substitution de chaîne.
      const slot = doc.createElement('span');
      slot.className = 'md-toc-page';
      slot.dataset.target = h.id;
      li.appendChild(slot);
```

- [ ] **Step 4: Habiller l'emplacement**

Ajouter à la fin de `renderer/styles.css` :

```css
/* ---------- Numéros de page du sommaire ---------- */
/* Vide à l'écran, rempli par l'export : la ligne de conduite ne s'affiche que
   lorsqu'il y a un numéro à rejoindre. */
.markdown-body .md-toc li:has(.md-toc-page:not(:empty)) {
  display: flex;
  align-items: baseline;
  gap: 0.4rem;
}
.markdown-body .md-toc-page:not(:empty) {
  margin-left: auto;
  font-variant-numeric: tabular-nums;
  color: var(--fg-muted);
}
.markdown-body .md-toc li:has(.md-toc-page:not(:empty))::after {
  content: '';
  order: 1;
  flex: 1;
  border-bottom: 1px dotted var(--border);
  margin: 0 0.2rem 0.25rem;
}
.markdown-body .md-toc-page:not(:empty) { order: 2; }
```

- [ ] **Step 5: Lancer les tests et les voir passer**

Run: `npm test`
Expected: 24 tests unitaires PASS, `46/46 checks passed` (42 + 4)

- [ ] **Step 6: Rendre l'export en deux passes**

Dans `main.js`, handler `file:export-pdf`, remplacer :

```js
  const buffer = await pdfWin.webContents.printToPDF(pdfOptions(options));
```

par :

```js
  // Les numéros de page ne s'obtiennent que du PDF lui-même : `offsetTop` se
  // trompe dès qu'une règle de pagination déplace un élément. On rend donc une
  // première fois pour savoir, puis une seconde pour montrer. Sans sommaire,
  // rien à remplir et la seconde passe est sautée.
  let buffer = await pdfWin.webContents.printToPDF(pdfOptions(options));
  if (html.includes('class="md-toc-page"')) {
    const numbered = fillTocPages(html, destinationPages(buffer));
    if (numbered !== html) {
      const restaged = await stageHtml(numbered);
      await pdfWin.loadFile(restaged);
      buffer = await pdfWin.webContents.printToPDF(pdfOptions(options));
      await fs.unlink(restaged).catch(() => {});
    }
  }
```

- [ ] **Step 7: Vérifier le résultat de bout en bout**

Ajouter à la FIN de `test/smoke.js`, juste avant `const failed = results.filter(...)` :

```js
  // Le seul test qui prouve la chaîne entière : rendre, lire les pages dans le
  // PDF, remplir, re-rendre.
  const { fillTocPages: fill, destinationPages: destPagesOf } = require(path.join(root, 'pdf.js'));
  const twoPass = await win.webContents.executeJavaScript(`(async () => {
    // `buildPrintableHtml()` appelle `render()`, qui reconstruit l'aperçu depuis
    // l'éditeur : écrire dans `preview.innerHTML` avant l'appel ne survivrait pas.
    window.newTab({ content: '[[toc]]\\n\\n# Un\\n\\n<!-- pagebreak -->\\n\\n# Deux\\n' });
    return await window.buildPrintableHtml({});
  })()`);
  const tmpTwo = path.join(app.getPath('temp'), `mdtopdf-twopass-${Date.now()}.html`);
  await fs.writeFile(tmpTwo, twoPass, 'utf8');
  const twoWin = new BrowserWindow({ show: false, webPreferences: { sandbox: true } });
  await twoWin.loadFile(tmpTwo);
  const firstPass = await twoWin.webContents.printToPDF({
    printBackground: true, pageSize: 'A4',
    margins: { top: 0.5, bottom: 0.5, left: 0.5, right: 0.5 },
    generateDocumentOutline: true, generateTaggedPDF: true,
  });
  const found = destPagesOf(firstPass);
  const numbered = fill(twoPass, found);
  check('la première passe situe les deux titres', found.un === 1 && found.deux === 2, JSON.stringify(found));
  check('la seconde passe inscrit les numéros', /data-target="deux">2<\/span>/.test(numbered));
  twoWin.close();
  await fs.unlink(tmpTwo).catch(() => {});
```

- [ ] **Step 8: Lancer la suite complète**

Run: `npm test`
Expected: 24 tests unitaires PASS, `48/48 checks passed` (46 + 2)

- [ ] **Step 9: Commit**

```bash
/usr/bin/git add -A
/usr/bin/git commit -m "feat: sommaire PDF avec numéros de page exacts"
```

---

### Task 3: Page de garde

**Files:**
- Modify: `renderer/renderer.js` (`render()`, `buildPrintableHtml()`, `readPdfOptions()`, `PDF_FIELDS`)
- Modify: `renderer/index.html` (modal d'export)
- Modify: `renderer/styles.css`
- Modify: `test/smoke.js`

**Interfaces:**
- Consumes: `stripFrontMatter()`, qui retourne déjà `{ meta, body }` mais dont seul `body` est utilisé.
- Produces: `<section class="pdf-cover">` en tête du HTML imprimable.

- [ ] **Step 1: Écrire les tests qui échouent**

Ajouter à la FIN de `test/smoke.js`, juste avant `const failed = results.filter(...)` :

```js
  const cover = await win.webContents.executeJavaScript(`(async () => {
    window.newTab({ content: '---\\ntitle: Rapport annuel\\nsubtitle: Exercice 2026\\nauthor: Khalil\\ndate: 17 septembre 2026\\n---\\n\\n# Contenu\\n' });
    const avec = await window.buildPrintableHtml({ cover: true });
    const sans = await window.buildPrintableHtml({ cover: false });
    return JSON.stringify({
      avec: avec.includes('pdf-cover'),
      titre: avec.includes('Rapport annuel'),
      soustitre: avec.includes('Exercice 2026'),
      auteur: avec.includes('Khalil'),
      date: avec.includes('17 septembre 2026'),
      sans: sans.includes('pdf-cover'),
    });
  })()`);
  const cv = JSON.parse(cover);
  check('la page de garde est insérée quand l’option est cochée', cv.avec, cover);
  check('elle reprend titre, sous-titre, auteur et date',
    cv.titre && cv.soustitre && cv.auteur && cv.date, cover);
  check('elle est absente quand l’option ne l’est pas', !cv.sans, cover);

  const coverVide = await win.webContents.executeJavaScript(`(async () => {
    window.newTab({ content: '# Sans front-matter\\n' });
    const html = await window.buildPrintableHtml({ cover: true });
    return JSON.stringify({ garde: html.includes('pdf-cover') });
  })()`);
  check('pas de page de garde sans titre en front-matter',
    !JSON.parse(coverVide).garde, coverVide);
```

- [ ] **Step 2: Lancer les tests et les voir échouer**

Run: `npm test`
Expected: FAIL sur les trois premiers — aucun `pdf-cover` produit

- [ ] **Step 3: Conserver le front-matter dans `renderer.js`**

Au-dessus de `function render()`, ajouter :

```js
// Le front-matter n'est retiré de l'aperçu que pour l'écran : la page de garde
// de l'export en a besoin.
let frontMatter = {};
```

Dans `render()`, remplacer `const { body } = stripFrontMatter(src);` par :

```js
  const { meta, body } = stripFrontMatter(src);
  frontMatter = meta;
```

- [ ] **Step 4: Construire la page de garde**

Au-dessus de `async function buildPrintableHtml(options)`, ajouter :

```js
// Une page de garde sans titre n'est qu'une page blanche : sans `title` en
// front-matter, on n'en met pas.
function coverHtml() {
  const title = frontMatter.title;
  if (!title) return '';
  const lines = [`<h1>${escapeHtml(title)}</h1>`];
  if (frontMatter.subtitle) lines.push(`<p class="pdf-cover-subtitle">${escapeHtml(frontMatter.subtitle)}</p>`);
  const meta = [frontMatter.author, frontMatter.date].filter(Boolean).map(escapeHtml);
  if (meta.length) lines.push(`<p class="pdf-cover-meta">${meta.join(' · ')}</p>`);
  return `<section class="pdf-cover">${lines.join('')}</section>`;
}
```

Dans `buildPrintableHtml()`, remplacer la fin du gabarit :

```js
  </style></head><body><div id="preview" class="markdown-body">${preview.innerHTML}</div></body></html>`;
```

par :

```js
  </style></head><body><div id="preview" class="markdown-body">${options.cover ? coverHtml() : ''}${preview.innerHTML}</div></body></html>`;
```

- [ ] **Step 5: Ajouter l'option au modal**

Dans `renderer/index.html`, après la ligne de la case `pdf-number-headings`, ajouter :

```html
      <label class="row"><input type="checkbox" id="pdf-cover" /> Page de garde (depuis le front-matter)</label>
```

Dans `renderer/renderer.js`, ajouter `'pdf-cover'` au tableau `PDF_FIELDS`, et dans `readPdfOptions()` ajouter :

```js
    cover: document.getElementById('pdf-cover').checked,
```

- [ ] **Step 6: Habiller la page de garde**

Ajouter à la fin de `renderer/styles.css` :

```css
/* ---------- Page de garde ---------- */
.markdown-body .pdf-cover {
  break-after: page;
  min-height: 80vh;
  display: flex;
  flex-direction: column;
  justify-content: center;
  text-align: center;
}
.markdown-body .pdf-cover h1 {
  font-size: 2.6em;
  border: 0;
  margin: 0 0 0.6rem;
}
.markdown-body .pdf-cover-subtitle {
  font-size: 1.3em;
  color: var(--fg-muted);
  margin: 0 0 2.5rem;
}
.markdown-body .pdf-cover-meta {
  color: var(--fg-muted);
  margin: 0;
}
```

- [ ] **Step 7: Lancer la suite complète**

Run: `npm test`
Expected: 24 tests unitaires PASS, `52/52 checks passed` (48 + 4)

- [ ] **Step 8: Commit**

```bash
/usr/bin/git add -A
/usr/bin/git commit -m "feat: page de garde alimentée par le front-matter"
```

---

### Task 4: Filigrane, documentation et version

**Files:**
- Modify: `renderer/renderer.js` (`buildPrintableHtml()`, `readPdfOptions()`, `PDF_FIELDS`)
- Modify: `renderer/index.html`
- Modify: `renderer/styles.css`
- Modify: `test/smoke.js`
- Modify: `README.md`
- Modify: `package.json` (version)

**Interfaces:**
- Consumes: `buildPrintableHtml()` de la tâche 3.
- Produces: rien.

- [ ] **Step 1: Écrire les tests qui échouent**

Ajouter à la FIN de `test/smoke.js`, juste avant `const failed = results.filter(...)` :

```js
  const marque = await win.webContents.executeJavaScript(`(async () => {
    window.newTab({ content: '# Document\\n' });
    const avec = await window.buildPrintableHtml({ watermark: 'BROUILLON' });
    const sans = await window.buildPrintableHtml({ watermark: '' });
    return JSON.stringify({
      avec: avec.includes('pdf-watermark') && avec.includes('BROUILLON'),
      sans: sans.includes('pdf-watermark'),
      fixe: /\\.pdf-watermark[^}]*position:\\s*fixed/.test(avec),
      echappe: (await window.buildPrintableHtml({ watermark: '<img src=x onerror=alert(1)>' })).includes('onerror=alert') === false,
    });
  })()`);
  const mq = JSON.parse(marque);
  check('le filigrane est inséré quand le champ est rempli', mq.avec, marque);
  check('il est absent quand le champ est vide', !mq.sans, marque);
  check('il est positionné en fixe, pour se répéter sur chaque page', mq.fixe, marque);
  check('le texte du filigrane est échappé', mq.echappe, marque);
```

- [ ] **Step 2: Lancer les tests et les voir échouer**

Run: `npm test`
Expected: FAIL sur les quatre — aucun `pdf-watermark`

- [ ] **Step 3: Insérer le filigrane**

Dans `renderer/renderer.js`, `buildPrintableHtml()`, remplacer :

```js
  </style></head><body><div id="preview" class="markdown-body">${options.cover ? coverHtml() : ''}${preview.innerHTML}</div></body></html>`;
```

par :

```js
  </style></head><body>${watermarkHtml(options.watermark)}<div id="preview" class="markdown-body">${options.cover ? coverHtml() : ''}${preview.innerHTML}</div></body></html>`;
```

et ajouter au-dessus de `coverHtml()` :

```js
// Position fixe : Chromium repeint un élément fixe sur chaque page imprimée —
// mesuré, le flux de chacune des trois pages d'un document témoin grossit.
function watermarkHtml(text) {
  const clean = (text || '').trim();
  return clean ? `<div class="pdf-watermark">${escapeHtml(clean)}</div>` : '';
}
```

- [ ] **Step 4: Ajouter le champ au modal**

Dans `renderer/index.html`, après le champ `pdf-header-text`, ajouter :

```html
      <label>Filigrane
        <input type="text" id="pdf-watermark" placeholder="(optionnel)" />
      </label>
```

Dans `renderer/renderer.js`, ajouter `'pdf-watermark'` au tableau `PDF_FIELDS`, et dans `readPdfOptions()` ajouter :

```js
    watermark: document.getElementById('pdf-watermark').value,
```

- [ ] **Step 5: Habiller le filigrane**

Ajouter à la fin de `renderer/styles.css` :

```css
/* ---------- Filigrane ---------- */
.pdf-watermark {
  position: fixed;
  top: 45%;
  left: 0;
  right: 0;
  text-align: center;
  font-size: 5rem;
  font-weight: 700;
  letter-spacing: 0.1em;
  color: rgba(180, 30, 30, 0.14);
  transform: rotate(-30deg);
  pointer-events: none;
  z-index: 9999;
}
```

- [ ] **Step 6: Lancer la suite complète**

Run: `npm test`
Expected: 24 tests unitaires PASS, `56/56 checks passed` (52 + 4)

- [ ] **Step 7: Documenter dans le README**

Dans la section « Export & impression », après la ligne des options d'export PDF, ajouter :

```markdown
- **Signets PDF** : la structure des titres devient un volet de navigation dans le lecteur, et le PDF est balisé, donc accessible
- **Sommaire paginé** : un `[[toc]]` exporté porte le numéro de page réel de chaque titre, lu dans le PDF lui-même plutôt que deviné
- **Liens internes cliquables** : les entrées du sommaire et les ancres du document restent navigables dans le PDF
- **Page de garde** optionnelle, composée depuis le front-matter (`title`, `subtitle`, `author`, `date`)
- **Filigrane** optionnel, répété sur chaque page
```

Dans la section « Architecture », après la ligne de `preload.js`, ajouter :

```markdown
├── pdf.js                      # Options de rendu, lecture des destinations d'un PDF,
│                               #   remplissage des numéros de page (sans Electron)
```

Dans le tableau des scripts npm, la ligne `npm test` devient :

```markdown
| `npm test` | Tests unitaires du moteur Markdown et de la chaîne PDF (`node --test`, sans Electron) puis test de fumée end-to-end |
```

- [ ] **Step 8: Passer la version à 1.4.0**

Dans `package.json`, remplacer `"version": "1.3.0"` par `"version": "1.4.0"`.

- [ ] **Step 9: Vérifier une dernière fois**

Run: `npm test`
Expected: 24 tests unitaires PASS, `56/56 checks passed`

- [ ] **Step 10: Commit**

```bash
/usr/bin/git add -A
/usr/bin/git commit -m "feat: filigrane, documentation de la chaîne PDF, version 1.4.0"
```
