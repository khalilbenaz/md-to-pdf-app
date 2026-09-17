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
