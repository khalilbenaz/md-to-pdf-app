# Lot B — Extensions Markdown

**Date** : 17 septembre 2026
**Statut** : en attente de validation
**Version cible** : 1.3.0

## Contexte

MD to PDF rend aujourd'hui du GFM (tableaux, cases à cocher), du KaTeX et du
Mermaid. Quatre constructions courantes des documents imprimés manquent : notes
de bas de page, admonitions, sommaire inséré dans le corps du document, et
légendes de figures numérotées.

Ce lot est le premier de quatre, décidés ensemble :

| Lot | Objet |
|---|---|
| **B — Extensions Markdown** | Ce document |
| A — Chaîne PDF | Signets, sommaire paginé, page de garde, filigrane |
| C — UX éditeur | Export par lot, mode focus, synchro bidirectionnelle |
| D — Distribution | Mise à jour automatique, gros documents, tests élargis |

B passe en premier parce qu'il est autonome et qu'il alimente A : une admonition
ou une note de bas de page doit d'abord exister pour qu'on puisse la paginer.

## Décisions de cadrage

| Question | Décision |
|---|---|
| Portabilité des `.md` | **Rester portable.** Syntaxes répandues, dégradation lisible ailleurs |
| Libellés générés | **Français en dur.** Cohérent avec l'interface, rien à configurer |
| Implémentation | **Greffons éprouvés + passes DOM** |
| Bibliothèques | **Déplacées dans le bundle esbuild** dans ce lot |

Conséquence directe du choix de portabilité : la syntaxe principale des
admonitions est `> [!NOTE]`, native sur GitHub et Obsidian, et qui dégrade en
simple citation partout ailleurs. `:::note` a été écarté comme syntaxe
principale parce qu'il s'affiche en texte brut hors des lecteurs qui le
connaissent ; il reste accepté en second.

## Architecture

### Frontière

`renderer.js` (640 lignes) configure marked, rend, gère les onglets, le
sommaire latéral, la recherche et les exports. Empiler quatre traitements de
rendu de plus y est le mauvais réflexe. Le lot introduit une frontière.

`renderer/markdown-src.js` — renommage de `vendor-src.js`, bundlé par esbuild —
devient le moteur de rendu markdown et le seul module qui connaisse marked,
KaTeX, highlight.js et les greffons. Interface :

```js
window.md = {
  parse(source) → html,
  enhance(rootElement) → { headings }
}
```

`renderer.js` ne référence plus `marked`, `katex` ni `hljs`. Son `render()` :

```js
preview.innerHTML = md.parse(body);
const { headings } = md.enhance(preview);
resolveLocalImages();
runMermaid();
buildToc(headings);
updateStats();
```

### Ce qui reste dehors

- **mermaid** — garde sa balise `<script>`. Son UMD fonctionne et le bundler
  dessus est un nid à problèmes (imports dynamiques par type de diagramme).
- **`resolveLocalImages()`** — dépend du chemin de l'onglet actif, donc de
  l'interface, pas du markdown.

### Pourquoi cette frontière

1. Les cinq balises `<script src="../node_modules/…">` disparaissent. C'est ce
   couplage qui a produit le bug des maths de la v1.1.3 : un shim ESM qui
   ré-exportait du CommonJS levait une `ReferenceError`, et l'enregistrement de
   KaTeX, accroché au même événement, ne se faisait jamais.
2. Les identifiants de titres sont attribués une seule fois. Aujourd'hui
   `buildToc()` reparcourt le DOM pour son compte ; avec `[[toc]]` en plus, les
   deux listes divergeraient.
3. Le moteur devient testable sans Electron : un module ES ordinaire que
   `node:test` importe et exerce en quelques millisecondes.

Le fichier navigateur se contente de lier le moteur à `window` ; la logique vit
dans un module importable, faute de quoi les tests unitaires auraient besoin
d'un `window` factice.

## Les quatre fonctionnalités

### 1. Notes de bas de page

**Greffon** : `marked-footnote` 1.4 (`marked >=7`, satisfait par 14.1).

`Texte[^1]` produit un appel en exposant lié à sa définition `[^1]: la note`.
Les notes sont rejetées en fin de document dans un `<section class="footnotes">`
précédé du titre « Notes », renumérotées dans l'ordre d'apparition, avec retour
arrière vers l'appel.

- Une définition jamais appelée n'est pas rendue.
- Un appel sans définition reste du texte littéral, comportement actuel.
- Une note peut contenir du code et des maths : même chaîne de rendu.

### 2. Admonitions

**Greffons** : `marked-alert` 2.1 pour `> [!TYPE]`, `marked-directive` 1.0 pour
`:::type`.

| Syntaxe | Titre rendu |
|---|---|
| `> [!NOTE]` | Note |
| `> [!TIP]` | Astuce |
| `> [!IMPORTANT]` | Important |
| `> [!WARNING]` | Attention |
| `> [!CAUTION]` | Danger |

`marked-alert` expose ses variantes (type, icône, classe de titre), ce qui
permet les titres français sans surcharge du rendu.

- Type inconnu : retombe en simple citation. Il dégrade, il ne casse pas.
- Icônes en SVG inline — pas de police d'icônes, compatible avec la CSP, et
  s'imprime.
- Une admonition imbriquée dans une liste est rendue normalement.

### 3. Sommaire `[[toc]]`

Un paragraphe ne contenant que `[[toc]]` devient un `<nav class="md-toc">`,
rempli par `enhance()` avec les titres de niveau 1 à 3.

**Correctif embarqué** : les identifiants de titres sont aujourd'hui `h-0`,
`h-1`, `h-2`, attribués par position. Ajouter un titre en haut du document
décale tous les suivants, donc une ancre d'un HTML exporté ne désigne plus la
même section d'un export à l'autre. `enhance()` les remplace par des slugs
dérivés du texte (`## Mise en page` → `#mise-en-page`), dédoublonnés par suffixe
numérique, compatibles GitHub.

- Document sans titre : rien n'est rendu, pas d'encadré vide.
- Titres identiques : `#notes`, `#notes-2`.
- Profondeur fixée à 1–3. Pas de paramètre : YAGNI.

### 4. Légendes de figures

Aucune syntaxe nouvelle — un paragraphe dont l'unique contenu est une image
devient `<figure><img><figcaption>Figure N — texte alternatif</figcaption></figure>`,
numérotée dans l'ordre du document. Le `.md` reste un markdown ordinaire
partout ailleurs.

**Décision** : une image sans texte alternatif ne reçoit ni légende ni numéro.
Elle reste dans un `<figure>` pour bénéficier des règles de saut de page. Une
image décorative ne doit pas consommer un numéro de figure.
*Coût si c'est faux* : la numérotation saute des images à compter ; correction
en quelques lignes, ou ajout d'un texte alternatif.

**Hors périmètre** : légendes de tableaux et de diagrammes mermaid. Un diagramme
n'a pas de texte alternatif d'où tirer une légende ; en inventer une syntaxe
contredirait le choix de portabilité.
*Coût si c'est faux* : un lot ultérieur.

- Une image en lien cliquable reste un lien : la structure du paragraphe diffère.

## Écran et impression

Le CSS vit dans `styles.css` et arrive automatiquement dans le PDF, l'impression
et le HTML exporté, puisque les trois chemins inlinent déjà cette feuille et
reprennent le DOM de l'aperçu.

- Une couleur par type d'admonition, déclinée clair et sombre via les variables
  CSS existantes (`--fg-muted`, `--border`, `--accent`…).
- `paginationCss()` gagne trois règles, partagées par les trois sorties :
  `.markdown-alert` et `figure` ne se coupent pas entre deux pages, et le bloc
  de notes ne peut pas être séparé de son premier élément.

## Tests

Le découpage rend deux niveaux possibles là où il n'y en avait qu'un.

**`test/markdown.test.js`** — `node:test`, importe le moteur directement, sans
Electron. Couvre `parse()` :

- les quatre syntaxes produisent le HTML attendu ;
- les cinq titres d'admonition sont en français ;
- un type d'admonition inconnu reste une citation ;
- une définition de note orpheline n'est pas rendue ;
- un appel de note orphelin reste littéral.

**`test/smoke.js`** — étendu. Couvre `enhance()`, qui exige un vrai DOM :

- `[[toc]]` peuplé avec les titres 1–3 ;
- figures numérotées dans l'ordre, image sans alt non numérotée ;
- slugs stables et dédoublonnés ;
- les quatre fonctionnalités **survivent dans le HTML imprimable**, pas
  seulement à l'écran.

`npm test` enchaîne les deux. La CI trois OS ne change pas.

## Périmètre

**Dans le lot**

- Les quatre fonctionnalités ci-dessus
- Le déplacement de marked, KaTeX et leurs extensions dans le bundle esbuild
- Le passage des identifiants de titres en slugs
- Les deux niveaux de tests

**Hors du lot**

- Sommaire PDF avec numéros de page → lot A
- Légendes de tableaux et de diagrammes
- Profondeur de sommaire paramétrable
- Libellés traduisibles ou surchargeables

## Risques

| Risque | Parade |
|---|---|
| Les titres de `marked-alert` ne se personnalisent pas comme annoncé | Surcharge du rendu de l'extension, ou titres injectés en CSS |
| Trois greffons non maintenus à terme | Syntaxes standard : remplaçables sans toucher aux documents |
| Le bundle grossit | marked et KaTeX étaient déjà chargés, ils changent de véhicule |
| `enhance()` ralentit la frappe | Passe linéaire sur un DOM déjà construit ; à mesurer sur un document de 5 000 lignes |
