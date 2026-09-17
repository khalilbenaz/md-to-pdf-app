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
    // Pas de pré-transformation ici : le test pré-remplaçait lui-même le
    // marqueur, si bien que la vérification portait sur son propre \`.replace\`
    // et passait encore si \`preprocess()\` disparaissait du moteur.
    preview.innerHTML = window.md.parse(${JSON.stringify(SAMPLE)});
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
  check('chaque ancre est résolue à sa page', destPages.un === 1 && destPages.deux === 2, JSON.stringify(destPages));
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

  // `marked-footnote` produit `<h2 id="footnote-label">Notes</h2>`, et chaque
  // appel de note porte `aria-describedby="footnote-label"`. Une réécriture
  // inconditionnelle de l'identifiant fait pointer toutes ces références dans
  // le vide. Et ce `<h2>` n'est pas un titre du document : il n'a rien à faire
  // dans le sommaire ni dans le panneau latéral.
  const notes = await win.webContents.executeJavaScript(`(() => {
    const preview = document.getElementById('preview');
    preview.innerHTML = window.md.parse('# Titre\\n\\nTexte[^1].\\n\\n[^1]: la note\\n');
    const { headings } = window.md.enhance(preview);
    return JSON.stringify({
      titres: headings.map(h => h.text),
      ancre: !!preview.querySelector('#footnote-label'),
    });
  })()`);
  const n = JSON.parse(notes);
  check('le titre du bloc de notes n’entre pas dans la liste des titres',
    !n.titres.includes('Notes'), notes);
  check('l’ancre #footnote-label survit à la passe DOM', n.ancre, notes);

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

  // Le marqueur ne doit se déclencher que sur un paragraphe qui n'est QUE le
  // texte `[[toc]]`. Sinon on ne peut pas documenter la syntaxe sans qu'elle
  // s'exécute : `\`[[toc]]\``, `**[[toc]]**` et `> [[toc]]` produisaient un
  // vrai sommaire, parce que `textContent` aplatit les enfants.
  const tocLitteral = await win.webContents.executeJavaScript(`(() => {
    const preview = document.getElementById('preview');
    const cas = {
      code: '\\\`[[toc]]\\\`\\n\\n# Un\\n\\n## Deux\\n',
      gras: '**[[toc]]**\\n\\n# Un\\n\\n## Deux\\n',
      citation: '> [[toc]]\\n\\n# Un\\n\\n## Deux\\n',
    };
    const out = {};
    for (const [nom, src] of Object.entries(cas)) {
      preview.innerHTML = window.md.parse(src);
      window.md.enhance(preview);
      out[nom] = !preview.querySelector('nav.md-toc');
    }
    preview.innerHTML = window.md.parse('[[toc]]\\n\\n# Un\\n\\n## Deux\\n');
    window.md.enhance(preview);
    out.nuReste = !!preview.querySelector('nav.md-toc');
    return JSON.stringify(out);
  })()`);
  const tl = JSON.parse(tocLitteral);
  check('[[toc]] entre accents graves reste du code littéral', tl.code, tocLitteral);
  check('[[toc]] en gras ou en citation ne déclenche pas le sommaire',
    tl.gras && tl.citation, tocLitteral);
  check('le marqueur [[toc]] nu déclenche toujours le sommaire', tl.nuReste, tocLitteral);

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

  // Jusqu'ici rien n'appelait `buildPrintableHtml()` : les seules vérifications
  // liées à l'export portaient sur le TEXTE retourné par `paginationCss()`.
  // C'est ce trou qui a laissé passer un CSS entièrement scopé `#preview`,
  // invisible dans le HTML exporté. On exerce donc le pipeline pour de vrai.
  // Ce bloc réécrit `preview.innerHTML` via `render()` : il doit rester le
  // dernier, sous peine de casser les vérifications de polices KaTeX ci-dessus.
  const EXPORT_SAMPLE = [
    '[[toc]]',
    '',
    '# Titre',
    '',
    '## Sous-titre',
    '',
    '> [!WARNING]',
    '> danger',
    '',
    '![Le schéma](a.png)',
    '',
    'Texte[^1].',
    '',
    '[^1]: la note',
    '',
  ].join('\n');

  const printable = await win.webContents.executeJavaScript(`(async () => {
    // \`editor\` est un \`let\` de premier niveau : il n'est pas sur \`window\`.
    // \`newTab\` est une déclaration de fonction, elle l'est, et elle passe par
    // le vrai chemin — \`setActiveTab\` → \`editor.setValue\` → \`render()\`.
    window.newTab({ content: ${JSON.stringify(EXPORT_SAMPLE)} });
    const html = await window.buildPrintableHtml({});
    const corps = html.slice(html.indexOf('<body>'));
    const style = html.slice(html.indexOf('<style>'), html.indexOf('</style>'));
    return JSON.stringify({
      corpsAlerte: corps.includes('markdown-alert-warning'),
      corpsToc: corps.includes('md-toc-title'),
      corpsFigure: corps.includes('Figure 1'),
      corpsNotes: corps.includes('class="footnotes"'),
      cssAlerte: style.includes('.markdown-body .markdown-alert'),
      cssToc: style.includes('.markdown-body .md-toc'),
      cssFigure: style.includes('.markdown-body figcaption'),
      cssNotes: style.includes('.markdown-body .footnotes'),
    });
  })()`);
  const pr = JSON.parse(printable);
  check('buildPrintableHtml() embarque l’encadré et le sommaire',
    pr.corpsAlerte && pr.corpsToc, printable);
  check('buildPrintableHtml() embarque la légende et le bloc de notes',
    pr.corpsFigure && pr.corpsNotes, printable);
  // L'assertion qui aurait attrapé le CSS scopé `#preview` : l'export HTML
  // n'enveloppe que dans `.markdown-body`, sans `id="preview"`.
  check('le CSS exporté stylise les encadrés et les sommaires via .markdown-body',
    pr.cssAlerte && pr.cssToc, printable);
  check('le CSS exporté stylise les légendes et les notes via .markdown-body',
    pr.cssFigure && pr.cssNotes, printable);

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

  // Le seul test qui prouve la chaîne entière : rendre, lire les pages dans le
  // PDF, remplir, re-rendre.
  const { fillTocPages: fill, destinationPages: destPagesOf } = require(path.join(root, 'pdf.js'));
  const twoPass = await win.webContents.executeJavaScript(`(async () => {
    // \`buildPrintableHtml()\` appelle \`render()\`, qui reconstruit l'aperçu depuis
    // l'éditeur : écrire dans \`preview.innerHTML\` avant l'appel ne survivrait pas.
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

  // Le CSS complet (styles.css inliné dans <style>) contient toujours le
  // sélecteur littéral `.pdf-cover`, que la page de garde soit produite ou
  // non : on ne peut donc chercher la sous-chaîne que dans le corps, pas dans
  // le document entier — même idiome que `corps`/`style` plus haut.
  const cover = await win.webContents.executeJavaScript(`(async () => {
    window.newTab({ content: '---\\ntitle: Rapport annuel\\nsubtitle: Exercice 2026\\nauthor: Khalil\\ndate: 17 septembre 2026\\n---\\n\\n# Contenu\\n' });
    const avec = await window.buildPrintableHtml({ cover: true });
    const sans = await window.buildPrintableHtml({ cover: false });
    const corpsAvec = avec.slice(avec.indexOf('<body>'));
    const corpsSans = sans.slice(sans.indexOf('<body>'));
    return JSON.stringify({
      avec: corpsAvec.includes('pdf-cover'),
      titre: corpsAvec.includes('Rapport annuel'),
      soustitre: corpsAvec.includes('Exercice 2026'),
      auteur: corpsAvec.includes('Khalil'),
      date: corpsAvec.includes('17 septembre 2026'),
      sans: corpsSans.includes('pdf-cover'),
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
    const corps = html.slice(html.indexOf('<body>'));
    return JSON.stringify({ garde: corps.includes('pdf-cover') });
  })()`);
  check('pas de page de garde sans titre en front-matter',
    !JSON.parse(coverVide).garde, coverVide);

  const failed = results.filter(x => !x.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  app.exit(failed.length ? 1 : 0);
}).catch(err => {
  console.error('harness error:', err);
  app.exit(1);
});
