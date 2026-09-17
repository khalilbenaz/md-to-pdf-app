// End-to-end smoke test: boots the real renderer in Electron and asserts that the
// pipeline actually produces what it claims to. Every check here maps to a bug
// that shipped silently — the KaTeX extension going unregistered because it was
// chained to a highlight.js import that threw, mermaid vanishing from exports
// when the code-block class changed, KaTeX fonts not resolving in the PDF.
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs/promises');

const root = path.join(__dirname, '..');
const results = [];

function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok || !detail ? '' : ' — ' + detail}`);
}

const SAMPLE = [
  '# Titre',
  '',
  '$$\\int_0^\\infty e^{-x^2} dx = \\frac{\\sqrt{\\pi}}{2}$$',
  '',
  'Inline $E = mc^2$ au fil du texte.',
  '',
  '```js',
  'const a = 1;',
  '```',
  '',
  '```mermaid',
  'graph TD; A-->B;',
  '```',
  '',
  '<!-- pagebreak -->',
  '',
  '<img src="x" onerror="window.__xss = true">',
  '',
  'Fin.',
].join('\n');

app.whenReady().then(async () => {
  // The renderer talks to the main process as soon as it boots; without stubs the
  // run is drowned in "no handler registered" noise.
  for (const channel of ['file:watch', 'file:read', 'folder:refresh', 'folder:search']) {
    ipcMain.handle(channel, () => null);
  }

  const cspViolations = [];
  const win = new BrowserWindow({
    show: false,
    webPreferences: { preload: path.join(root, 'preload.js') },
  });
  win.webContents.on('console-message', (_e, _lvl, message) => {
    if (/Refused to|Content Security Policy/i.test(message)) cspViolations.push(message);
  });

  await win.loadFile(path.join(root, 'renderer', 'index.html'));
  await new Promise(r => setTimeout(r, 1500));

  // --- libraries reached the renderer ---
  const libs = await win.webContents.executeJavaScript(
    'JSON.stringify({parse: typeof window.md?.parse, mermaid: typeof window.mermaid})'
  );
  const l = JSON.parse(libs);
  check('the markdown engine is available', l.parse === 'function', libs);
  check('mermaid is available', l.mermaid === 'object', libs);

  // --- the extensions are actually registered on marked ---
  const parsed = await win.webContents.executeJavaScript(
    `window.md.parse(${JSON.stringify(SAMPLE)})`
  );
  check('block math is typeset', parsed.includes('katex-display'));
  check('inline math is typeset', parsed.includes('class="katex"'));
  check('code is highlighted', parsed.includes('hljs'));

  // --- render the sample through the real preview ---
  const rendered = await win.webContents.executeJavaScript(`(async () => {
    const preview = document.getElementById('preview');
    preview.innerHTML = window.md.parse(${JSON.stringify(SAMPLE)}.replace(/<!--\\s*pagebreak\\s*-->/gi, '<div class="page-break"></div>'));
    const blocks = preview.querySelectorAll('pre code.language-mermaid, pre code.hljs.language-mermaid');
    blocks.forEach((el, i) => {
      const div = document.createElement('div');
      div.className = 'mermaid';
      div.id = 'test-mmd-' + i;
      div.textContent = el.textContent;
      el.closest('pre').replaceWith(div);
    });
    if (blocks.length) await window.mermaid.run({ querySelector: '.mermaid' });
    await new Promise(r => setTimeout(r, 300));
    return JSON.stringify({
      html: preview.innerHTML.length,
      mermaidSvg: !!preview.querySelector('.mermaid svg'),
      pageBreak: !!preview.querySelector('.page-break'),
      xss: !!window.__xss,
    });
  })()`);
  const r = JSON.parse(rendered);
  check('mermaid block becomes an SVG', r.mermaidSvg);
  check('<!-- pagebreak --> becomes an element', r.pageBreak);
  check('inline event handler from markdown does not run', !r.xss);
  // The sample deliberately smuggles in an onerror= handler, so exactly one
  // refusal is the pass condition; anything else means CSP broke the app itself.
  const expected = cspViolations.filter(m => /inline event handler/i.test(m));
  const unexpected = cspViolations.filter(m => !/inline event handler/i.test(m));
  check('CSP refuses the injected handler', expected.length > 0);
  check('CSP does not block the app\'s own resources', unexpected.length === 0, unexpected[0]);

  // A markdown file's images live next to it, outside the app folder; the CSP has
  // to keep letting those through.
  const localImage = path.join(app.getPath('temp'), `mdtopdf-test-${Date.now()}.png`);
  await fs.writeFile(localImage, Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64'));
  const imgResult = await win.webContents.executeJavaScript(`new Promise(res => {
    const img = new Image();
    img.onerror = () => res('error');
    img.onload = () => res('loaded:' + img.naturalWidth);
    img.src = ${JSON.stringify('file://' + localImage)};
    setTimeout(() => res('timeout'), 3000);
  })`);
  check('a local image outside the app folder still loads', imgResult === 'loaded:1', imgResult);
  await fs.unlink(localImage).catch(() => {});

  // --- the PDF really embeds the KaTeX fonts ---
  const exportHtml = await win.webContents.executeJavaScript(`(async () => {
    const katexCss = await (async () => {
      const href = new URL('../node_modules/katex/dist/katex.min.css', location.href);
      const css = await fetch(href).then(r => r.text());
      return css.replace(/url\\((['"]?)fonts\\//g, (_m, q) => 'url(' + q + new URL('fonts/', href).href);
    })();
    return '<!DOCTYPE html><html><head><meta charset="utf-8"><style>' + katexCss +
      '</style></head><body><div class="markdown-body">' + document.getElementById('preview').innerHTML + '</div></body></html>';
  })()`);

  const staged = path.join(app.getPath('temp'), `mdtopdf-test-${Date.now()}.html`);
  await fs.writeFile(staged, exportHtml, 'utf8');
  const pdfWin = new BrowserWindow({ show: false, webPreferences: { sandbox: true } });
  await pdfWin.loadFile(staged);
  const fonts = JSON.parse(await pdfWin.webContents.executeJavaScript(
    'document.fonts.ready.then(() => JSON.stringify([...document.fonts].filter(f => f.status === "loaded").map(f => f.family)))'
  ));
  check('KaTeX fonts resolve in the export', fonts.some(f => f.startsWith('KaTeX')), JSON.stringify(fonts));

  const pdf = await pdfWin.webContents.printToPDF({ printBackground: true, pageSize: 'A4' });
  check('printToPDF produces a PDF', pdf.length > 1000 && pdf.subarray(0, 4).toString() === '%PDF');
  check('KaTeX fonts are embedded in the PDF', /KaTeX_/.test(pdf.toString('latin1')));
  await fs.unlink(staged).catch(() => {});

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

  const failed = results.filter(x => !x.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  app.exit(failed.length ? 1 : 0);
}).catch(err => {
  console.error('harness error:', err);
  app.exit(1);
});
