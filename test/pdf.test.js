// Ce module est du CommonJS sans Electron ni DOM : `node --test` l'exerce
// directement, là où le test de fumée doit démarrer un navigateur.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { pdfOptions, destinationPages, fillTocPages, decodePdfName, hasTocSlots, tocSecondPass } = require('../pdf.js');

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
  // Chromium nomme ses destinations d'après le fragment d'URL, donc
  // percent-encodé, puis échappe le `%` lui-même en nom PDF : `#25` EST le `%`.
  // Relevé brut sur un vrai PDF :
  //   <</p#25C3#25A9rim#25C3#25A8tre-2026 [2 0 R /XYZ ...]
  //     /#25C3#25A7a-co#25C3#25BBte-cher [2 0 R /XYZ ...]>>
  // La forme `p#c3#a9rim#c3#a8tre`, qu'affirmait la spécification, n'est jamais
  // produite : c'est elle que ce test validait, d'où les accents sans numéro.
  assert.equal(decodePdfName('p#25C3#25A9rim#25C3#25A8tre-2026'), 'périmètre-2026');
  assert.equal(decodePdfName('#25C3#25A7a-co#25C3#25BBte-cher'), 'ça-coûte-cher');
  assert.equal(decodePdfName('mise-en-page'), 'mise-en-page');
});

test('un nom PDF au percent-encodage invalide ne fait pas échouer la lecture', () => {
  // Un `%` isolé fait lever decodeURIComponent : on rend alors la valeur non
  // décodée plutôt que de perdre toute la table des destinations.
  assert.equal(decodePdfName('taux-de-100#25-atteint'), 'taux-de-100%-atteint');
});

test('la table des destinations donne la page de chaque ancre', () => {
  const pdf = [
    '%PDF-1.7',
    '2 0 obj<</Type /Page /Parent 1 0 R>>endobj',
    '11 0 obj<</Type /Page /Parent 1 0 R>>endobj',
    '14 0 obj<</Type /Page /Parent 1 0 R>>endobj',
    '17 0 obj<</un [2 0 R /XYZ 0 0 0] /deux [11 0 R /XYZ 0 0 0] /p#25C3#25A9rim#25C3#25A8tre [14 0 R /XYZ 0 0 0]>>endobj',
    '20 0 obj<</Type /Catalog /Dests 17 0 R>>endobj',
  ].join('\n');
  assert.deepEqual({ ...destinationPages(Buffer.from(pdf, 'latin1')) }, {
    un: 1, deux: 2, 'périmètre': 3,
  });
});

test('la table des destinations suit l\'ordre du tableau /Kids, pas l\'ordre d\'apparition textuelle', () => {
  // L'objet de la page 3 (14 0 obj) est écrit en premier dans le fichier :
  // rien ne garantit que PDFium liste ses objets de page dans l'ordre de
  // lecture. Seul /Kids donne l'ordre réel des pages.
  const pdf = [
    '%PDF-1.7',
    '14 0 obj<</Type /Page /Parent 1 0 R>>endobj',
    '2 0 obj<</Type /Page /Parent 1 0 R>>endobj',
    '11 0 obj<</Type /Page /Parent 1 0 R>>endobj',
    '1 0 obj<</Type /Pages /Kids [2 0 R 11 0 R 14 0 R]>>endobj',
    '17 0 obj<</un [2 0 R /XYZ 0 0 0] /deux [11 0 R /XYZ 0 0 0] /p#25C3#25A9rim#25C3#25A8tre [14 0 R /XYZ 0 0 0]>>endobj',
    '20 0 obj<</Type /Catalog /Dests 17 0 R>>endobj',
  ].join('\n');
  assert.deepEqual({ ...destinationPages(Buffer.from(pdf, 'latin1')) }, {
    un: 1, deux: 2, 'périmètre': 3,
  });
});

test('la table des destinations descend un arbre de pages à plusieurs niveaux', () => {
  // Mesuré par le relecteur sur de vrais rendus : Skia n'émet un arbre plat que
  // jusqu'à 8 pages. Au-delà, il construit un arbre à plusieurs niveaux, et le
  // premier nœud `/Type /Pages` rencontré TEXTUELLEMENT est une FEUILLE (ici
  // `3 0 obj`, qui ne porte que les deux premières pages). Prendre ce nœud-là
  // faisait tomber tout le reste à `indexOf() === -1` : 9 destinations sur 20
  // pour un document de 20 pages, 5 sur 60 pour un document de 92 pages.
  // `10 0 obj` porte un sous-dictionnaire /Resources : le découpage du
  // dictionnaire doit équilibrer `<<` et `>>`, pas s'arrêter au premier `>>`.
  const pdf = [
    '%PDF-1.7',
    '3 0 obj<</Type /Pages /Parent 1 0 R /Kids [10 0 R 11 0 R] /Count 2>>endobj',
    '10 0 obj<</Type /Page /Parent 3 0 R /Resources <</Font <</F1 5 0 R>>>> >>endobj',
    '11 0 obj<</Type /Page /Parent 3 0 R>>endobj',
    '4 0 obj<</Type /Pages /Parent 1 0 R /Kids [12 0 R 13 0 R] /Count 2>>endobj',
    '12 0 obj<</Type /Page /Parent 4 0 R>>endobj',
    '13 0 obj<</Type /Page /Parent 4 0 R>>endobj',
    '1 0 obj<</Type /Pages /Kids [3 0 R 4 0 R] /Count 4>>endobj',
    '17 0 obj<</premier [10 0 R /XYZ 0 0 0] /deuxieme [11 0 R /XYZ 0 0 0]'
      + ' /troisieme [12 0 R /XYZ 0 0 0] /dernier [13 0 R /XYZ 0 0 0]>>endobj',
    '20 0 obj<</Type /Catalog /Pages 1 0 R /Dests 17 0 R>>endobj',
    'trailer<</Size 21 /Root 20 0 R>>',
  ].join('\n');
  assert.deepEqual({ ...destinationPages(Buffer.from(pdf, 'latin1')) }, {
    premier: 1, deuxieme: 2, troisieme: 3, dernier: 4,
  });
});

test('un arbre de pages qui boucle sur lui-même ne fait pas tourner la lecture', () => {
  // Une borne de profondeur et un ensemble d'objets déjà visités : un PDF
  // malformé coûte des numéros absents, jamais un export qui ne rend pas la main.
  const pdf = [
    '%PDF-1.7',
    '1 0 obj<</Type /Pages /Kids [3 0 R]>>endobj',
    '3 0 obj<</Type /Pages /Parent 1 0 R /Kids [1 0 R 10 0 R]>>endobj',
    '10 0 obj<</Type /Page /Parent 3 0 R>>endobj',
    '17 0 obj<</seule [10 0 R /XYZ 0 0 0]>>endobj',
    '20 0 obj<</Type /Catalog /Pages 1 0 R /Dests 17 0 R>>endobj',
    'trailer<</Root 20 0 R>>',
  ].join('\n');
  assert.deepEqual({ ...destinationPages(Buffer.from(pdf, 'latin1')) }, { seule: 1 });
});

test('une cible héritée d\'Object ne se prend pas pour un numéro de page', () => {
  // Un document contenant `## Constructor` donne la cible `constructor`.
  // Avec un objet littéral et un simple `pages[target]`, le remplissage écrivait
  // `function Object() { [native code] }` dans le sommaire, et `tocSecondPass`
  // annonçait `needed: true` pour rien.
  const pdf = [
    '%PDF-1.7',
    '2 0 obj<</Type /Page /Parent 1 0 R>>endobj',
    '1 0 obj<</Type /Pages /Kids [2 0 R]>>endobj',
    '17 0 obj<</un [2 0 R /XYZ 0 0 0]>>endobj',
    '20 0 obj<</Type /Catalog /Pages 1 0 R /Dests 17 0 R>>endobj',
    'trailer<</Root 20 0 R>>',
  ].join('\n');
  const pages = destinationPages(Buffer.from(pdf, 'latin1'));
  assert.equal(Object.getPrototypeOf(pages), null);
  assert.equal(pages.constructor, undefined);

  const html = '<span class="md-toc-page" data-target="constructor"></span>'
    + '<span class="md-toc-page" data-target="toString"></span>';
  assert.equal(fillTocPages(html, pages), html);
  assert.equal(tocSecondPass(html, Buffer.from(pdf, 'latin1')).needed, false);
});

test('un PDF sans destinations ne fait pas échouer la lecture', () => {
  assert.deepEqual({ ...destinationPages(Buffer.from('%PDF-1.7\n2 0 obj<</Type /Page>>endobj', 'latin1')) }, {});
});

test('les emplacements du sommaire reçoivent leur numéro', () => {
  const html = '<span class="md-toc-page" data-target="un"></span>'
    + '<span class="md-toc-page" data-target="absent"></span>';
  const out = fillTocPages(html, { un: 4 });
  assert.match(out, /data-target="un">4<\/span>/);
  assert.match(out, /data-target="absent"><\/span>/);
});

// PDF témoin, construit à la main comme les tests de destinationPages
// ci-dessus : une table de destinations avec une seule ancre résolue.
const PDF_TEMOIN = Buffer.from([
  '%PDF-1.7',
  '2 0 obj<</Type /Page /Parent 1 0 R>>endobj',
  '11 0 obj<</Type /Page /Parent 1 0 R>>endobj',
  '1 0 obj<</Type /Pages /Kids [2 0 R 11 0 R]>>endobj',
  '17 0 obj<</un [2 0 R /XYZ 0 0 0]>>endobj',
  '20 0 obj<</Type /Catalog /Dests 17 0 R>>endobj',
].join('\n'), 'latin1');

test('la présence d\'emplacements à remplir se lit sur le HTML seul', () => {
  // L'impression n'a pas d'usage du premier PDF : elle ne le rendrait que pour
  // mesurer. Elle doit donc pouvoir poser la question sans PDF sous la main,
  // et la poser exactement comme `tocSecondPass` — une seule définition.
  assert.equal(hasTocSlots('<span class="md-toc-page" data-target="un"></span>'), true);
  assert.equal(hasTocSlots('<p>Rien à remplir ici.</p>'), false);
});

test('un HTML sans emplacement ne déclenche pas de seconde passe', () => {
  const html = '<p>Rien à remplir ici.</p>';
  const result = tocSecondPass(html, PDF_TEMOIN);
  assert.equal(result.needed, false);
  assert.equal(result.html, html);
});

test('un HTML avec emplacements dont aucune cible ne figure dans la table ne déclenche pas de seconde passe', () => {
  const html = '<span class="md-toc-page" data-target="absent"></span>';
  const result = tocSecondPass(html, PDF_TEMOIN);
  assert.equal(result.needed, false);
  assert.equal(result.html, html);
});

test('un HTML avec emplacements résolus déclenche la seconde passe et remplit le HTML', () => {
  const html = '<span class="md-toc-page" data-target="un"></span>';
  const result = tocSecondPass(html, PDF_TEMOIN);
  assert.equal(result.needed, true);
  assert.match(result.html, /data-target="un">1<\/span>/);
});
