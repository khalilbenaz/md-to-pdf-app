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

  ipcMain.handle = (channel, fn) => { handlers[channel] = fn; try { vraiHandle(channel, fn); } catch {} };
  // `main.js` enregistre ses handlers au chargement du module, mais accroche
  // aussi `createWindow` à `app.whenReady`. Une promesse qui ne se résout
  // jamais laisse passer les premiers sans jamais déclencher la seconde :
  // l'application n'a pas à porter de branche de test pour ça.
  app.whenReady = () => new Promise(() => {});
  // Sans ça, `npm test` lancé pendant que l'application est ouverte perd le
  // verrou, `main.js` appelle `app.quit()` et la suite s'arrête en silence.
  app.requestSingleInstanceLock = () => true;

  require(path.join(root, 'main.js'));

  ipcMain.handle = vraiHandle;
  app.whenReady = vraiWhenReady;
  app.requestSingleInstanceLock = vraiVerrou;
  await new Promise((r) => setTimeout(r, 300));
  check('charger main.js n’ouvre aucune fenêtre d’application',
    BrowserWindow.getAllWindows().length === fenetresAvantChargement,
    `avant ${fenetresAvantChargement}, après ${BrowserWindow.getAllWindows().length}`);
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
  await fs.rm(lotDir, { recursive: true, force: true });

  const failed = results.filter(x => !x.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  clearTimeout(chienDeGarde);
  app.exit(failed.length ? 1 : 0);
}).catch(err => {
  console.error('harness error:', err);
  clearTimeout(chienDeGarde);
  app.exit(1);
});
