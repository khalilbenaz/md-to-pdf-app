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
    'JSON.stringify({hljs: typeof window.hljs, katex: typeof window.katex, katexExt: typeof window.markedKatex, mermaid: typeof window.mermaid, marked: typeof window.marked})'
  );
  const l = JSON.parse(libs);
  check('highlight.js is available', l.hljs === 'object', libs);
  check('KaTeX is available', l.katex === 'object', libs);
  check('marked-katex-extension is available', l.katexExt === 'function', libs);
  check('mermaid is available', l.mermaid === 'object', libs);

  // --- the extensions are actually registered on marked ---
  const parsed = await win.webContents.executeJavaScript(
    `window.marked.parse(${JSON.stringify(SAMPLE)})`
  );
  check('block math is typeset', parsed.includes('katex-display'));
  check('inline math is typeset', parsed.includes('class="katex"'));
  check('code is highlighted', parsed.includes('hljs'));

  // --- render the sample through the real preview ---
  const rendered = await win.webContents.executeJavaScript(`(async () => {
    const preview = document.getElementById('preview');
    preview.innerHTML = window.marked.parse(${JSON.stringify(SAMPLE)}.replace(/<!--\\s*pagebreak\\s*-->/gi, '<div class="page-break"></div>'));
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

  const failed = results.filter(x => !x.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  app.exit(failed.length ? 1 : 0);
}).catch(err => {
  console.error('harness error:', err);
  app.exit(1);
});
