# Lot A — Chaîne PDF

**Date** : 17 septembre 2026
**Statut** : validé, en implémentation
**Version cible** : 1.4.0
**Lot précédent** : `2026-09-17-markdown-extensions-design.md` (lot B, livré en 1.3.0)

## Contexte

L'export PDF produit aujourd'hui un document plat : pas de signets, un sommaire
`[[toc]]` cliquable mais sans numéros de page, aucune page de garde, aucun
filigrane. Ce lot comble ces quatre manques.

Chaque décision ci-dessous a été vérifiée sur Electron 32 avant d'être retenue.
Les mesures sont reproduites, parce que deux d'entre elles contredisent ce
qu'on supposerait.

## Ce que Chromium sait faire, mesuré

| Question | Réponse mesurée |
|---|---|
| `generateDocumentOutline: true` produit-il des signets ? | **Non, pas seul.** `{outline: false}`. Combiné à `generateTaggedPDF: true` : `{outline: true, titles: 3}` pour 3 titres |
| Les liens internes survivent-ils ? | **Oui**, déjà. Annotations `/Subtype /Link` avec `/Dest /<slug>` |
| Peut-on déduire la page d'un titre depuis `offsetTop` ? | **Non.** Mesuré page 2 pour un titre réellement page 3 : `offsetTop` ignore les sauts de page forcés |
| Le PDF dit-il sur quelle page est chaque destination ? | **Oui.** `/Dests` référence un objet simple, sans flux compressé. Lecteur validé : `{un: 1, deux: 2, trois: 3}` |
| Un filigrane `position: fixed` se répète-t-il ? | **Oui.** Flux de page 464/470/471 octets sans filigrane, 549/556/557 avec : les trois grossissent |

Coût du PDF balisé : 26 511 → 36 596 octets sur le document témoin, soit +38 %.
Contrepartie : le PDF devient accessible aux lecteurs d'écran.

## Décisions

| Sujet | Décision |
|---|---|
| Signets | `generateDocumentOutline` **et** `generateTaggedPDF`, toujours actifs |
| Numéros de page du sommaire | Deux passes, table `/Dests` lue dans le PDF de la première passe |
| Lecture du PDF | Lecteur maison d'une cinquantaine de lignes, **aucune dépendance** |
| Page de garde | Alimentée par le front-matter, activable dans le modal |
| Filigrane | Champ texte du modal, `position: fixed` |
| Liens internes | Rien à faire, test de non-régression seulement |

**Pourquoi pas de bibliothèque PDF** : `pdf-lib` pèse environ 1 Mo pour lire une
seule table. Chromium n'émet pas de flux d'objets ici (`objStm: false` mesuré),
donc les objets sont en clair et l'extraction tient en quelques expressions
régulières, testables unitairement sur un PDF réel.

**Pourquoi deux passes plutôt qu'une mesure dans le DOM** : la mesure par
`offsetTop` est fausse dès qu'une règle de pagination déplace un élément — et le
lot B en a justement ajouté cinq. Un numéro de page faux est pire qu'absent.

## Architecture

### A1 — Signets

`main.js`, handler `file:export-pdf` et handler `file:print` : ajouter les deux
options à l'appel `printToPDF`. Rien d'autre à changer.

### A2 — Sommaire paginé

**Côté aperçu** — `renderer/markdown/enhance.js`, `fillTableOfContents` ajoute à
chaque entrée un emplacement vide :

```html
<li class="md-toc-h2">
  <a href="#slug">Titre</a>
  <span class="md-toc-page" data-target="slug"></span>
</li>
```

Vide, il n'affiche rien à l'écran — les numéros de page n'ont de sens que sur
papier.

**Côté processus principal** — `main.js` gagne un module de lecture :

```js
// Chromium nomme ses destinations d'après les identifiants d'ancre du document,
// et n'utilise pas de flux d'objets : la table est donc lisible telle quelle.
function destinationPages(pdfBuffer) → { [slug]: pageNumber }
```

L'export devient : rendre une première fois → `destinationPages()` → remplir les
`<span class="md-toc-page">` par substitution de chaîne dans le HTML intermédiaire
→ rendre une seconde fois → écrire.

La seconde passe ne change pas la pagination : un numéro de page ajouté dans une
entrée de sommaire ne modifie pas la hauteur de la ligne. Si le sommaire devait
malgré tout déborder d'une page, les numéros resteraient ceux de la première
passe ; c'est un écart d'au plus une page sur un document dont le sommaire fait
exactement une page de trop. Accepté.

**Quand le document n'a pas de `[[toc]]`** : aucun `<span>` à remplir, la
seconde passe est sautée. L'export garde son coût actuel.

### A3 — Page de garde

`renderer/renderer.js`, `buildPrintableHtml()` : si l'option est cochée et que le
front-matter porte au moins un `title`, préfixer le corps d'un bloc :

```html
<section class="pdf-cover">
  <h1>…title…</h1>
  <p class="pdf-cover-subtitle">…subtitle…</p>
  <p class="pdf-cover-meta">…author… · …date…</p>
</section>
```

suivi d'un saut de page. Les champs absents ne sont pas rendus. Le front-matter
est déjà lu par `stripFrontMatter()`, qui retourne aujourd'hui `{ meta, body }`
et dont seul `body` est utilisé.

### A4 — Filigrane

Champ texte du modal. Non vide, `buildPrintableHtml()` insère
`<div class="pdf-watermark">…</div>` et la feuille d'export le positionne en
fixe. Vide, rien n'est inséré.

## Périmètre

**Dans le lot** : les quatre fonctionnalités, le lecteur de destinations et ses
tests, le test de non-régression des liens internes, deux options de plus dans
le modal d'export et leur mémorisation.

**Hors du lot** : signets à profondeur réglable, numérotation de page en chiffres
romains pour les pages liminaires, table des figures, export par lot (lot C).

## Risques

| Risque | Parade |
|---|---|
| Chromium change son émission de `/Dests` | Le lecteur retourne un objet vide, les numéros restent absents, l'export aboutit quand même |
| Le PDF balisé alourdit les gros documents | Mesuré à +38 % sur un document témoin ; à revoir si une plainte remonte |
| La seconde passe double le temps d'export | Sautée quand le document n'a pas de sommaire |
| Un slug contient un caractère qui casse la substitution | La substitution se fait sur `data-target="<slug>"`, une chaîne déjà échappée par le moteur |
