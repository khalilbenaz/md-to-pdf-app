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

test("une définition jamais appelée n'est pas rendue", () => {
  const html = parse('Rien.\n\n[^9]: jamais appelée\n');
  assert.doesNotMatch(html, /jamais appelée/);
  assert.doesNotMatch(html, /footnotes/);
});

test('un appel sans définition reste littéral', () => {
  const html = parse('Texte[^2] sans définition.\n');
  assert.match(html, /Texte\[\^2\] sans définition/);
});
