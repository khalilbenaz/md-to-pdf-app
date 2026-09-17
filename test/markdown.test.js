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
