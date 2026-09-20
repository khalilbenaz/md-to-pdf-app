// End-to-end smoke test: boots the real renderer in Electron and asserts that the
// pipeline actually produces what it claims to. Every check here maps to a bug
// that shipped silently — the KaTeX extension going unregistered because it was
// chained to a highlight.js import that threw, mermaid vanishing from exports
// when the code-block class changed, KaTeX fonts not resolving in the PDF.
const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs/promises');

const root = path.join(__dirname, '..');
const results = [];

// Une exécution interrompue — limite de session, terminal fermé, blocage —
// laissait le processus Electron vivant. Il se saborde désormais de lui-même.
const DELAI_MAX_MS = 3 * 60 * 1000;
const chienDeGarde = setTimeout(() => {
  console.error(`\nFAIL le test a dépassé ${DELAI_MAX_MS / 1000} s, arrêt forcé`);
  app.exit(1);
}, DELAI_MAX_MS);

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

  // Le CSS complet (styles.css inliné dans <style>) contient toujours le
  // sélecteur littéral `.pdf-watermark` : chercher cette sous-chaîne dans le
  // document entier serait vrai que le filigrane soit posé ou non. On la
  // cherche donc dans le corps, même idiome que pour la page de garde — sauf
  // pour la règle CSS elle-même, qui doit bien exister dans la feuille de
  // style et vaut `position: fixed`.
  const marque = await win.webContents.executeJavaScript(`(async () => {
    window.newTab({ content: '# Document\\n' });
    const avec = await window.buildPrintableHtml({ watermark: 'BROUILLON' });
    const sans = await window.buildPrintableHtml({ watermark: '' });
    const echappeHtml = await window.buildPrintableHtml({ watermark: '<img src=x onerror=alert(1)>' });
    const corpsAvec = avec.slice(avec.indexOf('<body>'));
    const corpsSans = sans.slice(sans.indexOf('<body>'));
    const corpsEchappe = echappeHtml.slice(echappeHtml.indexOf('<body>'));
    // escapeHtml() n'échappe que &<>"' : le texte « onerror=alert » reste tel
    // quel de part et d'autre des chevrons échappés, ce n'est pas un signe
    // d'échec. Ce qui compte est qu'aucune balise <img> non échappée
    // n'atteigne le document — sinon le gestionnaire onerror s'exécuterait.
    return JSON.stringify({
      avec: corpsAvec.includes('pdf-watermark') && corpsAvec.includes('BROUILLON'),
      sans: corpsSans.includes('pdf-watermark'),
      fixe: /\\.pdf-watermark[^}]*position:\\s*fixed/.test(avec),
      echappe: !corpsEchappe.includes('<img') && corpsEchappe.includes('&lt;img'),
    });
  })()`);
  const mq = JSON.parse(marque);
  check('le filigrane est inséré quand le champ est rempli', mq.avec, marque);
  check('il est absent quand le champ est vide', !mq.sans, marque);
  check('il est positionné en fixe, pour se répéter sur chaque page', mq.fixe, marque);
  check('le texte du filigrane est échappé', mq.echappe, marque);

  // Le `position: fixed` du filigrane vaut pour le papier — Chromium repeint
  // alors l'élément sur chaque page —, pas pour l'écran : dans le HTML exporté
  // autonome, ouvert dans un navigateur, il restait plaqué au milieu de la
  // fenêtre pendant tout le défilement. La règle se lit par le CSSOM, pas par
  // une expression régulière sur la source : c'est la cascade qui compte.
  const position = await win.webContents.executeJavaScript(`(() => {
    const el = document.createElement('div');
    el.className = 'pdf-watermark';
    document.body.appendChild(el);
    const ecran = getComputedStyle(el).position;
    el.remove();
    let impression = '';
    for (const sheet of document.styleSheets) {
      let regles;
      try { regles = sheet.cssRules; } catch { continue; }
      for (const regle of regles) {
        if (!regle.media || regle.conditionText !== 'print') continue;
        for (const interne of regle.cssRules || []) {
          if (interne.selectorText
            && interne.selectorText.includes('.pdf-watermark')
            && interne.style.position) impression = interne.style.position;
        }
      }
    }
    return JSON.stringify({ ecran, impression });
  })()`);
  const pos = JSON.parse(position);
  check('le filigrane n’est pas plaqué à la fenêtre hors impression',
    pos.ecran === 'absolute', position);
  check('il redevient fixe à l’impression, pour se répéter sur chaque page',
    pos.impression === 'fixed', position);

  // doExportHtml() ouvre une boîte de dialogue d'enregistrement : on ne peut
  // pas l'appeler depuis le test. buildExportHtml() en extrait le gabarit, et
  // doit honorer les mêmes options que buildPrintableHtml() — page de garde
  // et filigrane —, sinon un utilisateur qui les coche ne les voit pas dans
  // le HTML exporté.
  const exportAvecOptions = await win.webContents.executeJavaScript(`(async () => {
    window.newTab({ content: '---\\ntitle: Rapport annuel\\n---\\n\\n# Contenu\\n' });
    const html = await window.buildExportHtml({ cover: true, watermark: 'BROUILLON' });
    const corps = html.slice(html.indexOf('<body>'));
    return JSON.stringify({
      garde: corps.includes('pdf-cover') && corps.includes('Rapport annuel'),
      filigrane: corps.includes('pdf-watermark') && corps.includes('BROUILLON'),
    });
  })()`);
  const eh = JSON.parse(exportAvecOptions);
  check('l’export HTML inclut la page de garde quand l’option est cochée', eh.garde, exportAvecOptions);
  check('l’export HTML inclut le filigrane quand le champ est rempli', eh.filigrane, exportAvecOptions);


  // ── I2 / I3 : les deux handlers du processus principal ─────────────────────
  // main.js n'exporte rien : ses handlers ne sont joignables que par IPC depuis
  // un renderer, et `webContents.print()` ouvrirait la boîte système. On
  // intercepte donc `ipcMain.handle` avant de charger le module, ce qui donne
  // prise sur les fonctions elles-mêmes. Quelques canaux sont déjà stubbés en
  // tête de ce fichier : le second enregistrement lève, sans conséquence
  // puisque c'est la référence capturée qu'on appelle.
  // `main.js` ouvre la fenêtre principale sur `app.whenReady`. Si le test la
  // laisse s'ouvrir et qu'une exécution est interrompue — deux fois pendant le
  // lot A, par une limite de session — elle survit au test et reste dans le
  // Dock de l'utilisateur, rattachée à un worktree parfois déjà supprimé.
  const fenetresAvantChargement = BrowserWindow.getAllWindows().length;
  const handlers = {};
  const vraiHandle = ipcMain.handle.bind(ipcMain);
  const vraiWhenReady = app.whenReady.bind(app);
  const vraiVerrou = app.requestSingleInstanceLock.bind(app);
  const vraiOn = app.on.bind(app);

  ipcMain.handle = (channel, fn) => { handlers[channel] = fn; try { vraiHandle(channel, fn); } catch {} };
  // `main.js` enregistre ses handlers au chargement du module, mais accroche
  // aussi `createWindow` à `app.whenReady`. Une promesse qui ne se résout
  // jamais laisse passer les premiers sans jamais déclencher la seconde :
  // l'application n'a pas à porter de branche de test pour ça.
  app.whenReady = () => new Promise(() => {});
  // Sans ça, `npm test` lancé pendant que l'application est ouverte perd le
  // verrou, `main.js` appelle `app.quit()` et la suite s'arrête en silence.
  app.requestSingleInstanceLock = () => true;
  // I1 : `app.on` n'était pas neutralisé. Le verrou étant stubé à vrai,
  // `main.js` enregistre pour de vrai `window-all-closed`, qui appelle
  // `app.quit()` sur Linux et Windows — deux des trois OS de la CI — dès que
  // la dernière fenêtre se ferme. Une vérification qui ferme transitoirement
  // la dernière fenêtre ferait alors sortir `npm test` en code 0 sur une
  // suite tronquée, sans le moindre récapitulatif. On capture les
  // écouteurs sans jamais les poser pour de vrai, comme pour `ipcMain.handle`
  // côté enregistrement, restauré ensuite comme les trois autres.
  const ecouteursApp = {};
  // Electron pose lui-même, dès le démarrage du processus, un écouteur
  // interne par défaut sur `window-all-closed` (qui ne quitte que si c'est le
  // SEUL écouteur restant) : le compte de référence n'est donc pas zéro, mais
  // celui d'avant le chargement de `main.js`.
  const ecouteursReelsAvant = app.listenerCount('window-all-closed');
  app.on = (evenement, fn) => { (ecouteursApp[evenement] = ecouteursApp[evenement] || []).push(fn); return app; };

  require(path.join(root, 'main.js'));

  ipcMain.handle = vraiHandle;
  app.whenReady = vraiWhenReady;
  app.requestSingleInstanceLock = vraiVerrou;
  app.on = vraiOn;
  await new Promise((r) => setTimeout(r, 300));
  check('charger main.js n’ouvre aucune fenêtre d’application',
    BrowserWindow.getAllWindows().length === fenetresAvantChargement,
    `avant ${fenetresAvantChargement}, après ${BrowserWindow.getAllWindows().length}`);
  check('I1 — charger main.js n’attache aucun vrai écouteur window-all-closed (app.on neutralisé)',
    app.listenerCount('window-all-closed') === ecouteursReelsAvant,
    `avant=${ecouteursReelsAvant} après=${app.listenerCount('window-all-closed')}`);
  check('I1 — l’écouteur window-all-closed de main.js a bien été intercepté par le test',
    (ecouteursApp['window-all-closed'] || []).length > 0, JSON.stringify(Object.keys(ecouteursApp)));
  check('les handlers d’export et d’impression sont joignables',
    typeof handlers['file:print'] === 'function' && typeof handlers['file:export-pdf'] === 'function',
    Object.keys(handlers).join(', '));

  const tempDir = app.getPath('temp');
  const htmlTemporaires = async () => (await fs.readdir(tempDir)).filter((f) => /^mdtopdf-\d+-\w+\.html$/.test(f));

  // --- I2 : un loadFile en échec ne doit rien laisser derrière lui ---
  // Le relecteur a déclenché deux ERR_FAILED sur `loadFile` pendant ses essais :
  // sans try/finally, la fenêtre cachée reste vivante jusqu'à la fermeture de
  // l'application et le fichier temporaire — le document entier, images en data
  // URI comprises — reste sur le disque, à chaque tentative.
  const htmlAvantFuite = await htmlTemporaires();
  const fenetresAvant = BrowserWindow.getAllWindows().length;
  const vraiLoadFile = BrowserWindow.prototype.loadFile;
  BrowserWindow.prototype.loadFile = () => Promise.reject(new Error('ERR_FAILED (-2) loading'));
  let aLeve = false;
  try {
    await handlers['file:print'](null, { html: '<!DOCTYPE html><html><body>x</body></html>', options: {} });
  } catch { aLeve = true; }
  BrowserWindow.prototype.loadFile = vraiLoadFile;
  await new Promise((r) => setTimeout(r, 500));
  const htmlApresFuite = await htmlTemporaires();
  const restes = htmlApresFuite.filter((f) => !htmlAvantFuite.includes(f));
  check('un loadFile en échec fait bien remonter l’erreur de l’impression', aLeve);
  check('I2 — l’impression ne laisse pas de fichier temporaire derrière elle',
    restes.length === 0, JSON.stringify(restes));
  check('I2 — l’impression ne laisse pas de fenêtre cachée vivante',
    BrowserWindow.getAllWindows().length <= fenetresAvant,
    fenetresAvant + ' → ' + BrowserWindow.getAllWindows().length);

  // --- I2 : dans l'export, `close()` ne doit pas emporter le ménage ---
  // Sur une fenêtre déjà détruite, `close()` lève ; il précédait les
  // suppressions, qui n'avaient alors pas lieu.
  const vraiSaveDialog = dialog.showSaveDialog;
  const vraiShowItem = shell.showItemInFolder;
  const vraiClose = BrowserWindow.prototype.close;
  const ciblePdf = path.join(tempDir, `mdtopdf-test-export-${Date.now()}.pdf`);
  dialog.showSaveDialog = async () => ({ canceled: false, filePath: ciblePdf });
  shell.showItemInFolder = () => {};
  BrowserWindow.prototype.close = function () { throw new Error('Object has been destroyed'); };
  const htmlAvantExport = await htmlTemporaires();
  const fenetresAvantExport = BrowserWindow.getAllWindows();
  try {
    await handlers['file:export-pdf'](null, {
      html: '<!DOCTYPE html><html><body><h1>Un</h1></body></html>', defaultName: 'test', options: {},
    });
  } catch {}
  BrowserWindow.prototype.close = vraiClose;
  dialog.showSaveDialog = vraiSaveDialog;
  shell.showItemInFolder = vraiShowItem;
  for (const w of BrowserWindow.getAllWindows()) if (!fenetresAvantExport.includes(w)) w.destroy();
  await new Promise((r) => setTimeout(r, 300));
  const restesExport = (await htmlTemporaires()).filter((f) => !htmlAvantExport.includes(f));
  check('I2 — l’export supprime ses fichiers temporaires même si close() lève',
    restesExport.length === 0, JSON.stringify(restesExport));
  await fs.unlink(ciblePdf).catch(() => {});

  // --- I3 : l'impression part sur un sommaire paginé, comme l'export ---
  // Cmd/Ctrl+P puis « Enregistrer au format PDF » dans la boîte système est un
  // geste courant sous macOS : il donnait un sommaire aux emplacements vides
  // alors que le bouton « Exporter » d'à côté, sur le même document, les
  // remplit. On remplace `print()` par un relevé du document réellement chargé
  // au moment de l'impression — la boîte système n'a pas sa place dans un test.
  const wcProto = Object.getPrototypeOf(win.webContents);
  const vraiPrint = wcProto.print;
  let imprime = null;
  wcProto.print = function (_opts, cb) {
    this.executeJavaScript(
      'JSON.stringify([...document.querySelectorAll(".md-toc-page")].map(s => s.textContent))'
    ).then((r) => { imprime = r; cb(true, ''); }, (e) => { imprime = 'erreur: ' + e.message; cb(false, ''); });
  };
  const htmlAImprimer = await win.webContents.executeJavaScript(`(async () => {
    window.newTab({ content: '[[toc]]\\n\\n# Un\\n\\n<!-- pagebreak -->\\n\\n# Deux\\n' });
    return await window.buildPrintableHtml({});
  })()`);
  await handlers['file:print'](null, { html: htmlAImprimer, options: {} });
  wcProto.print = vraiPrint;
  check('I3 — l’impression part sur un sommaire paginé, comme l’export',
    typeof vraiPrint === 'function' && imprime !== null
      && JSON.parse(imprime.startsWith('[') ? imprime : '[]').join(',') === '1,2',
    String(imprime));


  // ── I4 : la chaîne complète sur un VRAI PDF long, accentué et paginé ───────
  // Les PDF écrits à la main des tests unitaires reconduisent les hypothèses
  // fausses : arbre de pages plat et noms de destination en `#c3`. Aucun ne
  // pouvait voir les trois constats Critical. Ce test rend un document réel de
  // plus de trente pages — bien au-delà des 8 pages en deçà desquelles Skia
  // aplatit son arbre (C1) —, comportant un titre accentué (C2), et le rend une
  // seconde fois une fois les numéros inscrits pour vérifier que le remplissage
  // ne repagine rien (C3).
  const { destinationPages: destLong, fillTocPages: fillLong, pdfOptions: optLong } = require(path.join(root, 'pdf.js'));
  const MESURE_TOC = `(() => {
    const toc = document.querySelector('.md-toc');
    const lis = [...document.querySelectorAll('.md-toc li')];
    return JSON.stringify({
      tocH: Math.round(toc.getBoundingClientRect().height),
      liH: lis.map(l => Math.round(l.getBoundingClientRect().height)),
      disp: lis.length ? getComputedStyle(lis[0]).display : '',
      num: lis.length ? lis[0].querySelector('.md-toc-page').textContent : '',
    });
  })()`;
  const longSrc = await win.webContents.executeJavaScript(`(async () => {
    // Des titres de longueurs finement croissantes : une entrée qui tenait
    // tout juste sur une ligne doit pouvoir basculer à deux si la mise en page
    // du sommaire change entre les deux passes. Le corps de chaque chapitre
    // s'écoule — pas de saut de page forcé —, sans quoi un décalage en tête de
    // document n'atteindrait jamais les chapitres suivants.
    const titres = [];
    for (let i = 1; i <= 60; i++) {
      titres.push('Chapitre ' + i + ' analyse de la mise en page ' + 'i '.repeat(i));
    }
    titres.splice(4, 0, 'Périmètre budgétaire et coûts détaillés');
    const corps = '\\n' + ('Texte de remplissage du chapitre qui occupe la page. '.repeat(30)) + '\\n';
    window.newTab({ content: '[[toc]]\\n\\n' + titres.map(t => '# ' + t + '\\n' + corps).join('\\n') });
    const html = await window.buildPrintableHtml({});
    const preview = document.getElementById('preview');
    return JSON.stringify({
      html,
      cibles: [...preview.querySelectorAll('.md-toc-page')].map(s => s.dataset.target),
    });
  })()`);
  const lg = JSON.parse(longSrc);
  const accentue = lg.cibles.find(t => /[éèêîôûàç]/.test(t));

  async function rendreLong(html, tag) {
    const file = path.join(app.getPath('temp'), `mdtopdf-long-${tag}-${Date.now()}.html`);
    await fs.writeFile(file, html, 'utf8');
    const w = new BrowserWindow({ show: false, webPreferences: { sandbox: true } });
    await w.loadFile(file);
    const geo = JSON.parse(await w.webContents.executeJavaScript(MESURE_TOC));
    const buf = await w.webContents.printToPDF(optLong({}));
    w.close();
    await fs.unlink(file).catch(() => {});
    return { geo, dest: destLong(buf) };
  }

  const avant = await rendreLong(lg.html, 'a');
  const apres = await rendreLong(fillLong(lg.html, avant.dest), 'b');

  const pagesLong = Math.max(0, ...Object.values(avant.dest));
  const manquantes = lg.cibles.filter(t => !(avant.dest[t] > 0));
  check('le document témoin dépasse le seuil de l’arbre de pages plat',
    lg.cibles.length >= 30 && pagesLong > 8,
    'entrées=' + lg.cibles.length + ' pages=' + pagesLong);
  check('C1 — toutes les ancres sont résolues, pas seulement les premières',
    manquantes.length === 0,
    manquantes.length + '/' + lg.cibles.length + ' non résolues, page max=' + pagesLong
      + ', ex. ' + JSON.stringify(manquantes.slice(0, 3)));
  check('C2 — le titre accentué est résolu',
    !!accentue && avant.dest[accentue] > 0,
    'cible=' + accentue + ' page=' + avant.dest[accentue]);
  // La comparaison des mises en page est la garde déterministe : le sommaire
  // du document imprimable doit se présenter à l'identique, rempli ou non, pour
  // que la première passe mesure déjà la pagination finale.
  check('C3 — le sommaire imprimable a la même mise en page, rempli ou non',
    avant.geo.disp === apres.geo.disp
      && avant.geo.tocH === apres.geo.tocH
      && JSON.stringify(avant.geo.liH) === JSON.stringify(apres.geo.liH),
    'display ' + avant.geo.disp + '→' + apres.geo.disp
      + ', hauteur ' + avant.geo.tocH + '→' + apres.geo.tocH
      + ', numéro ' + JSON.stringify(avant.geo.num) + '→' + JSON.stringify(apres.geo.num));
  const decalees = Object.keys(avant.dest).filter(k => avant.dest[k] !== apres.dest[k]);
  check('C3 — le remplissage ne repagine pas ce que la première passe a mesuré',
    decalees.length === 0
      && Object.keys(avant.dest).length === Object.keys(apres.dest).length,
    decalees.length + ' destinations déplacées, ex. '
      + JSON.stringify(decalees.slice(0, 3).map(k => k + ' : ' + avant.dest[k] + '→' + apres.dest[k])));

  // Deux défauts trouvés en REGARDANT un PDF produit, qu'aucune assertion ne
  // voyait : le repère « saut de page » de l'écran s'imprimait, et le titre de la
  // page de garde était numéroté, ce qui décalait tous les chapitres.
  const finitions = await win.webContents.executeJavaScript(`(() => {
    const css = window.paginationCss({ numberHeadings: true });
    return JSON.stringify({
      repereMasque: /#preview \\.page-break::after \\{ content: none; \\}/.test(css),
      gardeNonNumerotee: /\\.pdf-cover h1 \\{ counter-increment: none; \\}/.test(css),
    });
  })()`);
  const fin = JSON.parse(finitions);
  check('le repère de saut de page ne s’imprime pas', fin.repereMasque, finitions);
  check('le titre de la page de garde n’est pas numéroté', fin.gardeNonNumerotee, finitions);

  const palette = await win.webContents.executeJavaScript(`(() => {
    const avant = window.commands.all().length;
    let appels = 0;
    window.commands.register({ id: 'test:demo', titre: 'Commande de démonstration', executer: () => { appels += 1; } });
    const trouve = window.commands.filtrer('demo').map(c => c.id);
    const flou = window.commands.filtrer('cmddm').map(c => c.id);
    window.commands.run('test:demo');
    window.palette.ouvrir();
    const ouverte = !document.getElementById('palette').classList.contains('hidden');
    window.palette.fermer();
    const fermee = document.getElementById('palette').classList.contains('hidden');
    return JSON.stringify({ avant, trouve, flou, appels, ouverte, fermee,
      inconnue: window.commands.run('test:inexistante') });
  })()`);
  const pal = JSON.parse(palette);
  check('des commandes sont enregistrées au démarrage', pal.avant > 0, palette);
  check('la recherche retrouve une commande par son titre', pal.trouve.includes('test:demo'), palette);
  check('la recherche est floue, pas littérale', pal.flou.includes('test:demo'), palette);
  check('exécuter une commande par son identifiant l’appelle', pal.appels === 1, palette);
  check('une commande inconnue ne lève pas', pal.inconnue === false, palette);
  check('la palette s’ouvre et se ferme', pal.ouverte && pal.fermee, palette);

  // Configuration PAR DÉFAUT : le volet éditeur est masqué au démarrage
  // (`codePaneVisible` absent du localStorage), donc `editor.focus()` seul
  // serait un no-op. On mémorise plutôt ce qui avait le focus avant
  // l'ouverture — ici un bouton de la barre d'outils — et on vérifie qu'on
  // le retrouve à la fermeture, sans rien supposer de l'état du volet code.
  const focusDefaut = await win.webContents.executeJavaScript(`(() => {
    const bouton = document.getElementById('btn-theme');
    bouton.focus();
    window.palette.ouvrir();
    window.palette.fermer();
    return JSON.stringify({ rendu: document.activeElement === bouton });
  })()`);
  const fd = JSON.parse(focusDefaut);
  check('fermer la palette rend le focus à ce qui l’avait, volet éditeur masqué', fd.rendu, focusDefaut);

  const focus = await win.webContents.executeJavaScript(`(() => {
    const etaitActif = document.body.classList.contains('focus');
    window.commands.run('vue:focus');
    const actif = document.body.classList.contains('focus');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    const sorti = !document.body.classList.contains('focus');
    return JSON.stringify({ etaitActif, actif, sorti,
      commande: window.commands.all().some(c => c.id === 'vue:focus') });
  })()`);
  const fo = JSON.parse(focus);
  check('le mode focus est une commande', fo.commande, focus);
  check('il n’est pas actif au démarrage', !fo.etaitActif, focus);
  check('la commande l’active', fo.actif, focus);
  check('Échap en sort', fo.sorti, focus);

  // Second cas : le volet éditeur est visible et c'est lui qui avait le
  // focus avant l'ouverture de la palette — la restitution doit aussi
  // marcher dans cette configuration.
  const focusEditeurVisible = await win.webContents.executeJavaScript(`(() => {
    const toggle = document.getElementById('toggle-editor');
    if (!toggle.checked) { toggle.checked = true; toggle.dispatchEvent(new Event('change')); }
    const editorEl = document.getElementById('editor');
    editorEl.querySelector('.cm-content')?.focus();
    window.palette.ouvrir();
    window.palette.fermer();
    return JSON.stringify({ focusRendu: editorEl.contains(document.activeElement) });
  })()`);
  const fev = JSON.parse(focusEditeurVisible);
  check('fermer la palette rend le focus à l’éditeur quand il l’avait, volet visible', fev.focusRendu, focusEditeurVisible);

  // Un Échap par couche, la plus interne d'abord : palette ouverte en mode
  // focus, le premier Échap ne doit fermer que la palette (pas quitter le
  // mode focus), le second en sort. L'événement est déclenché sur le champ
  // de la palette, effectivement focus, pour emprunter la vraie chaîne de
  // remontée (bubbling) jusqu'à `document`.
  const echapCombine = await win.webContents.executeJavaScript(`(() => {
    window.commands.run('vue:focus');
    window.palette.ouvrir();
    document.getElementById('palette-requete').dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    const paletteFermee = document.getElementById('palette').classList.contains('hidden');
    const toujoursActif = document.body.classList.contains('focus');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    const sortiEnsuite = !document.body.classList.contains('focus');
    return JSON.stringify({ paletteFermee, toujoursActif, sortiEnsuite });
  })()`);
  const ec = JSON.parse(echapCombine);
  check('un Échap palette+focus ferme la palette sans quitter le mode focus', ec.paletteFermee && ec.toujoursActif, echapCombine);
  check('un second Échap quitte ensuite le mode focus', ec.sortiEnsuite, echapCombine);

  // ── Export par lot ──────────────────────────────────────────────────────
  const lotDir = path.join(app.getPath('temp'), `mdtopdf-lot-${Date.now()}`);
  await fs.mkdir(lotDir, { recursive: true });
  await fs.writeFile(path.join(lotDir, 'un.md'), '# Un\n\nTexte.\n', 'utf8');
  await fs.writeFile(path.join(lotDir, 'deux.md'), '# Deux\n\nTexte.\n', 'utf8');
  await fs.writeFile(path.join(lotDir, 'note.txt'), 'pas du markdown', 'utf8');

  check('le handler d’écriture directe est joignable', typeof handlers['file:export-pdf-to'] === 'function');
  check('le handler de liste markdown est joignable', typeof handlers['folder:list-markdown'] === 'function');

  // I2 : `file:export-pdf-to` se confine au dossier retourné par le dernier
  // `folder:list-markdown` — on l'appelle donc réellement une première fois
  // pour établir ce dossier de référence avant d'exercer l'écriture directe.
  const vraiOpenDialogInit = dialog.showOpenDialog;
  dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [lotDir] });
  await handlers['folder:list-markdown']();
  dialog.showOpenDialog = vraiOpenDialogInit;

  const htmlLot = await win.webContents.executeJavaScript(`(async () => {
    window.newTab({ content: '# Un\\n\\nTexte.\\n' });
    return await window.buildPrintableHtml({});
  })()`);
  const cible = path.join(lotDir, 'un.pdf');
  const ecrit = await handlers['file:export-pdf-to'](null, { html: htmlLot, chemin: cible, options: {} });
  const octets = await fs.readFile(cible).then((b) => b.length).catch(() => 0);
  check('l’écriture directe produit un PDF', ecrit && ecrit.chemin === cible && octets > 1000, String(octets));

  const commandeLot = await win.webContents.executeJavaScript(
    `window.commands.all().some(c => c.id === 'export:lot')`);
  check('l’export par lot est une commande', commandeLot === true);

  // Revue : le processus principal doit savoir dire si l'écriture directe a
  // remplacé un PDF existant, pour que le lot puisse le compter.
  const reecrit = await handlers['file:export-pdf-to'](null, { html: htmlLot, chemin: cible, options: {} });
  check('l’écriture directe signale le remplacement d’un PDF existant', reecrit && reecrit.remplace === true, JSON.stringify(reecrit));

  // I2 : `file:export-pdf-to` écrivait à n'importe quel chemin fourni par le
  // renderer, sans dialogue ni vérification. Il doit refuser tout chemin hors
  // du dossier du dernier lot, et tout chemin qui ne finit pas par .pdf.
  const horsDossier = path.join(app.getPath('temp'), `mdtopdf-hors-lot-${Date.now()}.pdf`);
  let refusHorsDossier = null;
  try {
    await handlers['file:export-pdf-to'](null, { html: htmlLot, chemin: horsDossier, options: {} });
  } catch (e) { refusHorsDossier = e.message; }
  const horsDossierEcrit = await fs.access(horsDossier).then(() => true).catch(() => false);
  check('I2 — l’écriture directe refuse un chemin hors du dossier du lot',
    !!refusHorsDossier && !horsDossierEcrit, String(refusHorsDossier));

  const pasUnPdf = path.join(lotDir, 'un.txt');
  let refusExtension = null;
  try {
    await handlers['file:export-pdf-to'](null, { html: htmlLot, chemin: pasUnPdf, options: {} });
  } catch (e) { refusExtension = e.message; }
  const extensionEcrite = await fs.access(pasUnPdf).then(() => true).catch(() => false);
  check('I2 — l’écriture directe refuse un chemin qui ne finit pas par .pdf',
    !!refusExtension && !extensionEcrite, String(refusExtension));

  await fs.rm(lotDir, { recursive: true, force: true });

  // ── Export par lot : revue — un seul onglet, refus si modifs non
  // enregistrées, collision de noms détectée ──────────────────────────────
  // Un onglet modifié interdit de démarrer, et sans solliciter la moindre
  // boîte de dialogue : le refus a lieu avant l'appel à `listMarkdown`.
  const refusDirty = await win.webContents.executeJavaScript(`(async () => {
    const t = window.newTab({ content: '# Modifié\\n' });
    t.dirty = true;
    await window.exporterLot();
    const message = document.getElementById('file-name').textContent;
    t.dirty = false;
    window.closeTab(t);
    return message;
  })()`);
  check('le lot refuse de démarrer quand un onglet est modifié', /enregistr/i.test(refusDirty), refusDirty);

  // nom.md et nom.markdown viseraient le même PDF : le second doit être
  // ignoré et compté, pas écraser le premier en silence.
  const conflit = await win.webContents.executeJavaScript(`(() => {
    return JSON.stringify(window.detecterConflitsLot(['deux.markdown', 'deux.md', 'un.md']));
  })()`);
  const rc = JSON.parse(conflit);
  check('la collision de noms est détectée',
    rc.conflits === 1 && rc.aTraiter.length === 2 && rc.aTraiter.includes('un.md') && rc.aTraiter.includes('deux.markdown'),
    conflit);

  // Un lot ne doit laisser ni onglet supplémentaire ni onglet en moins
  // derrière lui : un seul onglet de travail est créé, puis refermé.
  const lotDir2 = path.join(app.getPath('temp'), `mdtopdf-lot2-${Date.now()}`);
  await fs.mkdir(lotDir2, { recursive: true });
  await fs.writeFile(path.join(lotDir2, 'a.md'), '# A\n\nTexte.\n', 'utf8');
  await fs.writeFile(path.join(lotDir2, 'b.md'), '# B\n\nTexte.\n', 'utf8');
  const vraiOpenDialog = dialog.showOpenDialog;
  dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [lotDir2] });
  // `file:read` est stubbé à `() => null` en tête de ce fichier pour faire
  // taire le bruit des canaux non testés — mais `exporterLot()` en a besoin
  // ici pour de vrai. On substitue donc la référence capturée du handler réel
  // de `main.js`, le temps de ce test.
  ipcMain.removeHandler('file:read');
  ipcMain.handle('file:read', handlers['file:read']);
  const avantApres = await win.webContents.executeJavaScript(`(async () => {
    window.newTab({ content: '# Origine\\n' });
    const avant = document.querySelectorAll('#tabs .tab').length;
    await window.exporterLot();
    const apres = document.querySelectorAll('#tabs .tab').length;
    const resume = document.getElementById('file-name').textContent;
    return JSON.stringify({ avant, apres, resume });
  })()`);
  dialog.showOpenDialog = vraiOpenDialog;
  const aa = JSON.parse(avantApres);
  check('le nombre d’onglets est le même avant et après un lot', aa.avant === aa.apres, avantApres);
  check('le message final résume le lot réellement traité', /^2 PDF écrits dans /.test(aa.resume), avantApres);
  await fs.rm(lotDir2, { recursive: true, force: true });

  // ── C1 : en configuration par défaut (panneau ouvert, volet code fermé),
  // le mode focus doit vraiment passer `main` en une seule colonne — mesuré
  // sur la géométrie réelle, pas sur la seule présence de la classe `focus`,
  // qui passait alors même que la grille restait à 240px 1fr et que
  // `#preview` se retrouvait coincé dans la première colonne (240px).
  // Un onglet au contenu très court (juste un titre) exerce en plus un
  // second piège de la même famille : `margin: auto` sur un élément de
  // grille dont la largeur reste `auto` désactive l'étirement et retombe sur
  // un ajustement à la largeur du contenu, ce qui collait la colonne de
  // lecture à la largeur d'un titre au lieu de la largeur de lecture visée.
  const geometrieFocus = await win.webContents.executeJavaScript(`(() => {
    const toggle = document.getElementById('toggle-editor');
    if (toggle.checked) { toggle.checked = false; toggle.dispatchEvent(new Event('change')); }
    window.newTab({ content: '# Titre court\\n' });
    const main = document.querySelector('main');
    const previewEl = document.getElementById('preview');
    window.commands.run('vue:focus');
    const largeurMain = main.getBoundingClientRect().width;
    const largeurPreview = previewEl.getBoundingClientRect().width;
    const editorVisible = getComputedStyle(document.getElementById('editor')).display !== 'none';
    window.commands.run('vue:focus');
    return JSON.stringify({ largeurMain, largeurPreview, editorVisible });
  })()`);
  const gf = JSON.parse(geometrieFocus);
  // La colonne de lecture est plafonnée à 46rem (voir styles.css) : dans une
  // fenêtre plus large que ça, #preview ne doit PAS égaler la largeur de
  // main — c'est le seuil de lecture qui doit gagner, pas un étirement
  // intégral. On vérifie donc qu'elle occupe tout l'espace disponible
  // jusqu'à ce plafond, quelle que soit la longueur du contenu.
  const plafondLecture = 46 * 16;
  const attendu = Math.min(gf.largeurMain, plafondLecture);
  check('C1 — en mode focus, #preview occupe la largeur de lecture disponible, pas la largeur d’un titre court',
    Math.abs(gf.largeurPreview - attendu) < 2, geometrieFocus + ' attendu=' + attendu);
  check('C1 — en mode focus, le volet code reste masqué même s’il était ouvert',
    !gf.editorVisible, geometrieFocus);

  // ── C2 : l'export par lot doit refuser un second appel pendant qu'un
  // premier tourne. Sans garde, les deux boucles s'entrelacent sur `preview`
  // et `activeTab` — buildPrintableHtml() relit preview.innerHTML après
  // plusieurs `await`, un PDF peut recevoir le contenu d'un autre fichier —
  // et rien ne le détecte. Le refus doit avoir lieu avant tout `await`
  // (avant même la boîte de dialogue du dossier), donc être visible dès
  // l'appel synchrone du second lot, sans attendre sa résolution.
  const lotDir3 = path.join(app.getPath('temp'), `mdtopdf-lot3-${Date.now()}`);
  await fs.mkdir(lotDir3, { recursive: true });
  await fs.writeFile(path.join(lotDir3, 'x.md'), '# X\n\nTexte.\n', 'utf8');
  await fs.writeFile(path.join(lotDir3, 'y.md'), '# Y\n\nTexte.\n', 'utf8');
  const vraiOpenDialog2 = dialog.showOpenDialog;
  dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [lotDir3] });
  const concurrence = await win.webContents.executeJavaScript(`(async () => {
    window.newTab({ content: '# Origine 2\\n' });
    const p1 = window.exporterLot();
    const p2 = window.exporterLot();
    const messageImmediat = document.getElementById('file-name').textContent;
    await Promise.all([p1, p2]);
    return JSON.stringify({ messageImmediat });
  })()`);
  dialog.showOpenDialog = vraiOpenDialog2;
  const cc = JSON.parse(concurrence);
  check('C2 — un second export par lot pendant qu’un premier tourne est refusé, et le dit',
    /déjà en cours/i.test(cc.messageImmediat), concurrence);
  await fs.rm(lotDir3, { recursive: true, force: true });

  // ── C3 : pendant un lot, l'enregistrement automatique est suspendu et
  // l'onglet de travail ne peut pas être enregistré ni fermé. L'onglet de
  // travail vise successivement chaque fichier source du lot : sans garde,
  // une frappe pendant le lot armerait scheduleAutosave(), qui écrirait deux
  // secondes plus tard dans le fichier source ; et Cmd+W fermerait un onglet
  // que la prochaine itération du lot réactive alors qu'il n'existe plus.
  // Le déclenchement réel de l'autosave dépend d'un délai de 2 s dans une
  // fenêtre cachée (`show:false`), où Chromium peut retarder les
  // minuteurs : plutôt que d'attendre ce délai pour de vrai (lent et
  // possiblement peu fiable), le test intercepte `setTimeout` pour vérifier
  // directement la décision de programmation, et appelle `saveFile()` de
  // façon synchrone pour vérifier le refus d'écriture — les deux chemins que
  // l'autosave et Cmd+S empruntent réellement.
  const lotDir4 = path.join(app.getPath('temp'), `mdtopdf-lot4-${Date.now()}`);
  await fs.mkdir(lotDir4, { recursive: true });
  await fs.writeFile(path.join(lotDir4, 'p.md'), '# P\n\nTexte.\n', 'utf8');
  await fs.writeFile(path.join(lotDir4, 'q.md'), '# Q\n\nTexte.\n', 'utf8');
  const vraiOpenDialog3 = dialog.showOpenDialog;
  dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [lotDir4] });
  // On remplace le vrai handler d'enregistrement par un espion qui ne touche
  // pas le disque : si une garde échoue, le scénario appellerait `file:save`
  // avec un chemin qui pointe vers un fichier source du lot — l'espion le
  // détecte sans jamais risquer d'écrire quoi que ce soit pour de vrai.
  const vraiSaveHandler = handlers['file:save'];
  let appelsSauvegarde = 0;
  ipcMain.removeHandler('file:save');
  ipcMain.handle('file:save', () => { appelsSauvegarde += 1; return null; });
  // La vitesse réelle de lecture disque + rendu PDF varie avec la charge de
  // la machine ; sans un délai déterministe, l'état « en cours » du lot peut
  // se dérober à un sondage même rapproché. `file:read` est le premier
  // aller-retour IPC de chaque itération, juste après que le texte
  // « Export … » est posé : le ralentir garantit une fenêtre d'observation
  // stable, indépendante du temps réel de génération du PDF.
  const vraiReadHandler = handlers['file:read'];
  ipcMain.removeHandler('file:read');
  ipcMain.handle('file:read', async (...args) => {
    await new Promise((r) => setTimeout(r, 150));
    return vraiReadHandler(...args);
  });
  const suspension = await win.webContents.executeJavaScript(`(async () => {
    // Sans la garde de fermeture, l'onglet de travail venant d'être marqué
    // modifié atteindrait la confirmation de perte de modifications : un vrai
    // dialogue natif bloquerait ce test. On l'accepte automatiquement, ce qui
    // laisse le défaut se manifester (l'onglet se ferme) sans jamais faire
    // dépendre le test d'un dialogue système.
    window.confirm = () => true;
    document.getElementById('toggle-autosave').checked = true;
    window.newTab({ content: '# Origine 3\\n' });
    const avantOnglets = document.querySelectorAll('#tabs .tab').length;
    const lot = window.exporterLot();
    let tentatives = 0;
    while (!document.getElementById('file-name').textContent.startsWith('Export ') && tentatives < 4000) {
      await new Promise(r => setTimeout(r, 5));
      tentatives += 1;
    }
    const pendantLeLot = document.getElementById('file-name').textContent.startsWith('Export ');
    // L'onglet de travail est actif : appeler saveFile() directement emprunte
    // exactement le chemin que Cmd+S ou l'autosave débouclée emprunteraient.
    await window.saveFile();
    // Simule une frappe pendant le lot, sur l'onglet de travail : sans la
    // garde, ceci arme un minuteur à 2000 ms via scheduleAutosave().
    // L'interception de setTimeout constate la décision sans attendre le
    // délai réel.
    let minuteurAutosaveArme = false;
    const vraiSetTimeout = window.setTimeout;
    window.setTimeout = function (fn, delai, ...reste) {
      if (delai === 2000) minuteurAutosaveArme = true;
      return vraiSetTimeout(fn, delai, ...reste);
    };
    window.markDirty();
    window.setTimeout = vraiSetTimeout;
    const ongletsPendantLot = document.querySelectorAll('#tabs .tab').length;
    const boutonFermer = document.querySelector('#tabs .tab.active .close');
    if (boutonFermer) boutonFermer.click();
    const ongletsApresFermeture = document.querySelectorAll('#tabs .tab').length;
    await lot;
    const ongletsApresLot = document.querySelectorAll('#tabs .tab').length;
    return JSON.stringify({ pendantLeLot, avantOnglets, ongletsPendantLot, ongletsApresFermeture, ongletsApresLot, minuteurAutosaveArme });
  })()`);
  dialog.showOpenDialog = vraiOpenDialog3;
  ipcMain.removeHandler('file:save');
  ipcMain.handle('file:save', vraiSaveHandler);
  ipcMain.removeHandler('file:read');
  ipcMain.handle('file:read', vraiReadHandler);
  const su = JSON.parse(suspension);
  check('C3 — le lot atteint bien l’onglet de travail avant la vérification', su.pendantLeLot, suspension);
  check('C3 — l’onglet de travail ne peut pas être enregistré pendant un lot',
    appelsSauvegarde === 0, suspension);
  check('C3 — une frappe pendant un lot n’arme pas le minuteur d’autosave',
    su.minuteurAutosaveArme === false, suspension);
  check('C3 — Cmd+W ne ferme pas l’onglet de travail pendant un lot',
    su.ongletsPendantLot === su.ongletsApresFermeture, suspension);
  check('C3 — le lot laisse le même nombre d’onglets qu’à son démarrage, malgré la tentative de fermeture',
    su.ongletsApresLot === su.avantOnglets, suspension);
  await fs.rm(lotDir4, { recursive: true, force: true });

  // ── I3 : la modale PDF est la couche la plus interne et doit avoir son
  // propre gestionnaire Échap, appliqué avant les couches plus externes — en
  // particulier avant que le mode focus ne se ferme, ce qui ferait
  // réapparaître l'habillage derrière une modale restée ouverte. Cas à trois
  // couches : palette ouverte sur une modale PDF ouverte sur le mode focus ;
  // chaque Échap ne doit fermer que la couche la plus interne encore ouverte.
  const troisCouches = await win.webContents.executeJavaScript(`(() => {
    window.commands.run('vue:focus');
    window.showPdfModal();
    window.palette.ouvrir();
    const modal = document.getElementById('pdf-modal');
    const etat = () => ({
      paletteOuverte: !document.getElementById('palette').classList.contains('hidden'),
      modalOuverte: !modal.classList.contains('hidden'),
      focusActif: document.body.classList.contains('focus'),
    });
    const avant = etat();
    document.getElementById('palette-requete').dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    const apresUn = etat();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    const apresDeux = etat();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    const apresTrois = etat();
    return JSON.stringify({ avant, apresUn, apresDeux, apresTrois });
  })()`);
  const tc = JSON.parse(troisCouches);
  check('I3 — les trois couches sont bien ouvertes avant le premier Échap',
    tc.avant.paletteOuverte && tc.avant.modalOuverte && tc.avant.focusActif, troisCouches);
  check('I3 — le premier Échap ne ferme que la palette',
    !tc.apresUn.paletteOuverte && tc.apresUn.modalOuverte && tc.apresUn.focusActif, troisCouches);
  check('I3 — le deuxième Échap ferme la modale PDF, pas le mode focus',
    !tc.apresDeux.modalOuverte && tc.apresDeux.focusActif, troisCouches);
  check('I3 — le troisième Échap quitte enfin le mode focus',
    !tc.apresTrois.focusActif, troisCouches);

  // ── I4 : un fichier en échec dans le lot doit être journalisé (nom +
  // erreur) et nommé dans le message final — pas juste compté par un `catch`
  // muet.
  const lotDir5 = path.join(app.getPath('temp'), `mdtopdf-lot5-${Date.now()}`);
  await fs.mkdir(lotDir5, { recursive: true });
  await fs.writeFile(path.join(lotDir5, 'a.md'), '# A\n\nTexte.\n', 'utf8');
  await fs.writeFile(path.join(lotDir5, 'b.md'), '# B\n\nTexte.\n', 'utf8');
  const vraiOpenDialog4 = dialog.showOpenDialog;
  dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [lotDir5] });
  const vraiExportHandler2 = handlers['file:export-pdf-to'];
  ipcMain.removeHandler('file:export-pdf-to');
  ipcMain.handle('file:export-pdf-to', async (e, args) => {
    if (args.chemin.endsWith('b.pdf')) throw new Error('échec simulé pour la revue I4');
    return vraiExportHandler2(e, args);
  });
  // console.error() dans exporterLot() s'exécute côté renderer : il faut
  // l'écouter via console-message sur webContents, pas patcher le
  // console.error du processus principal (qui ne verrait que les propres
  // journaux d'Electron pour un handler IPC en échec, pas celui-ci).
  const messagesConsole = [];
  const ecouteurConsole = (_e, _lvl, message) => messagesConsole.push(message);
  win.webContents.on('console-message', ecouteurConsole);
  const resultatI4 = await win.webContents.executeJavaScript(`(async () => {
    window.newTab({ content: '# Origine 4\\n' });
    await window.exporterLot();
    return document.getElementById('file-name').textContent;
  })()`);
  win.webContents.off('console-message', ecouteurConsole);
  dialog.showOpenDialog = vraiOpenDialog4;
  ipcMain.removeHandler('file:export-pdf-to');
  ipcMain.handle('file:export-pdf-to', vraiExportHandler2);
  check('I4 — le fichier fautif et l’erreur sont journalisés en console',
    messagesConsole.some((m) => m.includes('b.md')), JSON.stringify(messagesConsole));
  check('I4 — le message final nomme le premier fichier fautif',
    /b\.md/.test(resultatI4) && /en échec/.test(resultatI4), resultatI4);
  await fs.rm(lotDir5, { recursive: true, force: true });

  // ── I5 : les raccourcis du registre étaient des littéraux `Cmd+…`, faux
  // hors macOS — l'application livre aussi un installeur Windows. On ne peut
  // pas changer la plateforme réelle de ce processus de test : on charge donc
  // l'application dans une fenêtre à part, avec un préchargement qui se fait
  // passer pour Windows avant de déléguer au vrai preload.js.
  // Un preload isolé ne peut pas `require()` un second fichier local
  // arbitraire (résolution de module restreinte) : on combine donc la
  // source réelle de preload.js avec la redéfinition de plateforme dans un
  // seul fichier temporaire, plutôt que d'en charger un second par-dessus.
  const preloadWin32 = path.join(app.getPath('temp'), `mdtopdf-preload-win32-${Date.now()}.js`);
  const sourcePreloadReel = await fs.readFile(path.join(root, 'preload.js'), 'utf8');
  await fs.writeFile(
    preloadWin32,
    `Object.defineProperty(process, 'platform', { value: 'win32' });\n${sourcePreloadReel}`,
    'utf8'
  );
  const winWin32 = new BrowserWindow({ show: false, webPreferences: { preload: preloadWin32 } });
  const messagesWin32 = [];
  winWin32.webContents.on('console-message', (_e, _lvl, message) => messagesWin32.push(message));
  winWin32.webContents.on('preload-error', (_e, p, error) => messagesWin32.push('preload-error: ' + p + ' ' + error.message));
  await winWin32.loadFile(path.join(root, 'renderer', 'index.html'));
  await new Promise((r) => setTimeout(r, 1000));
  const raccourcisWin32 = await winWin32.webContents.executeJavaScript(
    `JSON.stringify({ plateforme: window.api?.platform, raccourci: window.commands?.all().find(c => c.id === 'fichier:enregistrer')?.raccourci, aApi: typeof window.api, aCommands: typeof window.commands, console: ${JSON.stringify(messagesWin32)} })`
  ).catch((e) => JSON.stringify({ erreurExec: e.message, console: messagesWin32 }));
  winWin32.close();
  await fs.unlink(preloadWin32).catch(() => {});
  const rw = JSON.parse(raccourcisWin32);
  check('I5 — le registre affiche Ctrl (pas Cmd) hors macOS',
    rw.plateforme === 'win32' && rw.raccourci === 'Ctrl+S', raccourcisWin32);

  // ── I6 : en mode focus, l'en-tête (où vit #file-name) est masqué. Un
  // utilisateur qui lance un lot en mode focus avec un onglet modifié ne
  // voyait donc ni sélecteur ni refus. Le message doit rester visible via un
  // conteneur que le mode focus ne masque pas.
  const muetEnFocus = await win.webContents.executeJavaScript(`(async () => {
    window.commands.run('vue:focus');
    const t = window.newTab({ content: '# Modifié en focus\\n' });
    t.dirty = true;
    await window.exporterLot();
    const notif = document.getElementById('lot-notification');
    const resultat = {
      focusActif: document.body.classList.contains('focus'),
      enTeteMasquee: getComputedStyle(document.querySelector('header')).display === 'none',
      notifVisible: !notif.classList.contains('hidden')
        && getComputedStyle(notif).display !== 'none',
      notifTexte: notif.textContent,
    };
    t.dirty = false;
    window.closeTab(t);
    window.commands.run('vue:focus');
    return JSON.stringify(resultat);
  })()`);
  const mf = JSON.parse(muetEnFocus);
  check('I6 — l’en-tête est bien masquée en mode focus (condition du défaut)',
    mf.focusActif && mf.enTeteMasquee, muetEnFocus);
  check('I6 — le message de refus du lot reste visible en mode focus',
    mf.notifVisible && /enregistr/i.test(mf.notifTexte), muetEnFocus);

  // ── Minor 1 : installer.iss doit annoncer la même version que le manifeste.
  const pkgVersion = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8')).version;
  const issSrc = await fs.readFile(path.join(root, 'installer.iss'), 'utf8');
  const issVersion = (issSrc.match(/#define MyAppVersion "([^"]+)"/) || [])[1];
  check('Minor 1 — installer.iss annonce la même version que package.json',
    issVersion === pkgVersion, `installer.iss=${issVersion} package.json=${pkgVersion}`);

  // ── Minor 3 : commands.run() doit envelopper l'exécution — un `executer`
  // asynchrone qui rejette ne doit pas produire un rejet de promesse
  // invisible, il doit être journalisé.
  const messagesMinor3 = [];
  const ecouteurMinor3 = (_e, _lvl, message) => messagesMinor3.push(message);
  win.webContents.on('console-message', ecouteurMinor3);
  const rejetInvisible = await win.webContents.executeJavaScript(`(async () => {
    let vu = false;
    window.addEventListener('unhandledrejection', () => { vu = true; });
    window.commands.register({
      id: 'test:echoue',
      titre: 'Commande qui échoue',
      executer: () => Promise.reject(new Error('échec simulé pour Minor 3')),
    });
    window.commands.run('test:echoue');
    await new Promise(r => setTimeout(r, 200));
    return JSON.stringify({ rejetNonAttrape: vu });
  })()`);
  win.webContents.off('console-message', ecouteurMinor3);
  const ri = JSON.parse(rejetInvisible);
  check('Minor 3 — un executer() asynchrone qui rejette ne produit pas de rejet non attrapé',
    ri.rejetNonAttrape === false, rejetInvisible);
  check('Minor 3 — l’échec est journalisé en console',
    messagesMinor3.some((m) => m.includes('test:echoue')), JSON.stringify(messagesMinor3));

  // ── Minor 4 : Cmd/Ctrl+Shift+P doit être idempotent — un second appui
  // pendant que la palette est déjà ouverte ne doit pas écraser la mémoire
  // du focus précédent avec le champ de la palette elle-même.
  const idempotence = await win.webContents.executeJavaScript(`(() => {
    const bouton = document.getElementById('btn-theme');
    bouton.focus();
    window.palette.ouvrir();
    window.palette.ouvrir();
    window.palette.fermer();
    return JSON.stringify({ rendu: document.activeElement === bouton });
  })()`);
  check('Minor 4 — un second appel à palette.ouvrir() n’écrase pas le focus précédent mémorisé',
    JSON.parse(idempotence).rendu, idempotence);

  // ── Minor 5 : la branche « plus aucun onglet » du lot doit rappeler la
  // surveillance de fichier à null, comme setActiveTab() le fait partout
  // ailleurs — sinon le processus principal continue de surveiller le
  // dernier fichier du lot alors qu'aucun onglet ne le représente plus.
  // `file:watch` est stubbé à `() => null` en tête de ce fichier : on
  // installe le vrai handler (déjà capturé dans `handlers`) le temps du
  // test, pour observer les arguments réels des appels.
  const vraiWatchHandler = handlers['file:watch'];
  const appelsWatch = [];
  ipcMain.removeHandler('file:watch');
  ipcMain.handle('file:watch', (e, filePath) => { appelsWatch.push(filePath); return vraiWatchHandler(e, filePath); });
  const lotDir6 = path.join(app.getPath('temp'), `mdtopdf-lot6-${Date.now()}`);
  await fs.mkdir(lotDir6, { recursive: true });
  await fs.writeFile(path.join(lotDir6, 'seul.md'), '# Seul\n\nTexte.\n', 'utf8');
  const vraiOpenDialog5 = dialog.showOpenDialog;
  dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [lotDir6] });
  const surveillance = await win.webContents.executeJavaScript(`(async () => {
    window.confirm = () => true;
    // Ferme tous les onglets existants : le lot doit démarrer sans aucun
    // onglet d'origine pour atteindre la branche « plus aucun onglet ».
    let bouton;
    while ((bouton = document.querySelector('#tabs .tab .close'))) bouton.click();
    await window.exporterLot();
    return JSON.stringify({ activeTabNul: !document.querySelector('#tabs .tab.active') });
  })()`);
  dialog.showOpenDialog = vraiOpenDialog5;
  ipcMain.removeHandler('file:watch');
  ipcMain.handle('file:watch', vraiWatchHandler);
  const surv = JSON.parse(surveillance);
  check('Minor 5 — après un lot qui ne laisse aucun onglet, la surveillance de fichier est rappelée à null',
    appelsWatch.length > 0 && appelsWatch[appelsWatch.length - 1] === null,
    JSON.stringify(appelsWatch));
  await fs.rm(lotDir6, { recursive: true, force: true });

  // ── Minor 6 : detecterConflitsLot garde le premier dans l'ordre
  // alphabétique ; comme la liste vient triée de folder:list-markdown,
  // `note.markdown` (avant `note.md` alphabétiquement — 'a' < 'd' à la
  // première lettre qui diffère) est gardé, `note.md` est ignoré. Le README
  // affirmait l'inverse.
  const conflitExemple = await win.webContents.executeJavaScript(
    `JSON.stringify(window.detecterConflitsLot(['note.markdown', 'note.md'].sort()))`
  );
  const ce = JSON.parse(conflitExemple);
  check('Minor 6 — entre note.md et note.markdown, celui trié en premier (note.markdown) est gardé',
    ce.aTraiter.length === 1 && ce.aTraiter[0] === 'note.markdown' && ce.conflits === 1, conflitExemple);
  const readmeSrc6 = await fs.readFile(path.join(root, 'README.md'), 'utf8');
  check('Minor 6 — le README ne dit plus que le second (note.markdown) est ignoré',
    !/`note\.markdown` visant le même `note\.pdf` : le second est ignoré/.test(readmeSrc6), 'README non corrigé');
  check('Minor 6 — le README dit que note.markdown est gardé', /note\.markdown.*avant.*note\.md/.test(readmeSrc6), 'phrase absente');

  const failed = results.filter(x => !x.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  clearTimeout(chienDeGarde);
  app.exit(failed.length ? 1 : 0);
}).catch(err => {
  console.error('harness error:', err);
  clearTimeout(chienDeGarde);
  app.exit(1);
});
