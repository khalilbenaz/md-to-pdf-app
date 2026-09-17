// ---------- Mermaid ----------
if (window.mermaid) mermaid.initialize({ startOnLoad: false, theme: 'default', securityLevel: 'strict' });

// ---------- Front-matter ----------
function stripFrontMatter(md) {
  const m = md.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!m) return { meta: {}, body: md };
  const meta = {};
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^([\w-]+)\s*:\s*(.*)$/);
    if (kv) meta[kv[1]] = kv[2].trim().replace(/^["']|["']$/g, '');
  }
  return { meta, body: md.slice(m[0].length) };
}

// ---------- DOM ----------
const tabsEl = document.getElementById('tabs');
const editorParent = document.getElementById('editor');
const preview = document.getElementById('preview');
const fileNameEl = document.getElementById('file-name');
const statsEl = document.getElementById('stats');
const cursorEl = document.getElementById('cursor-pos');
const dirtyEl = document.getElementById('dirty-indicator');

// ---------- State ----------
let tabs = [];
let activeTab = null;
let folderRoot = null;
let editor = null;
let suppressChange = false;

// ---------- Editor (CodeMirror 6) ----------
function initEditor() {
  const dark = document.documentElement.getAttribute('data-theme') === 'dark';
  editor = window.createEditor(editorParent, {
    initial: '',
    dark,
    onChange: (doc) => {
      if (suppressChange) return;
      if (activeTab) activeTab.content = doc;
      scheduleRender();
      markDirty();
    },
    onScroll: (dom) => syncScroll(dom, preview),
    onCursor: ({ line, col }) => { cursorEl.textContent = `Ln ${line} · Col ${col}`; },
  });
}

let renderTimer;
function scheduleRender() { clearTimeout(renderTimer); renderTimer = setTimeout(render, 120); }

// ---------- Tabs ----------
function newTab({ path = null, content = '' } = {}) {
  const t = { id: Date.now() + Math.random(), path, content, dirty: false };
  tabs.push(t);
  setActiveTab(t);
  return t;
}

// Ouvre un fichier : réutilise un onglet "Sans titre" vierge (ex. l'accueil) au lieu d'en empiler un nouveau
function openInTab({ path, content }) {
  const existing = tabs.find(t => t.path === path);
  if (existing) { setActiveTab(existing); return existing; }
  const pristine = tabs.find(t => !t.path && !t.dirty);
  if (pristine) {
    pristine.path = path;
    pristine.content = content;
    setActiveTab(pristine);
    markClean();
    return pristine;
  }
  const t = newTab({ path, content });
  markClean();
  return t;
}

function setActiveTab(t) {
  activeTab = t;
  suppressChange = true;
  editor.setValue(t.content);
  suppressChange = false;
  fileNameEl.textContent = t.path ? t.path.split(/[\\/]/).pop() : 'Sans titre';
  render();
  renderTabs();
  window.api.watchFile(t.path || null);
  highlightTreeActive();
}

function closeTab(t) {
  if (t.dirty && !confirm('Fermer l\'onglet sans enregistrer ?')) return;
  const i = tabs.indexOf(t);
  tabs.splice(i, 1);
  if (activeTab === t) {
    if (tabs.length) setActiveTab(tabs[Math.max(0, i - 1)]);
    else { activeTab = null; suppressChange = true; editor.setValue(''); suppressChange = false; preview.innerHTML = ''; fileNameEl.textContent = 'Sans titre'; renderTabs(); }
  } else renderTabs();
}

function renderTabs() {
  tabsEl.innerHTML = '';
  for (const t of tabs) {
    const el = document.createElement('div');
    el.className = 'tab' + (t === activeTab ? ' active' : '');
    const name = t.path ? t.path.split(/[\\/]/).pop() : 'Sans titre';
    el.innerHTML = `${t.dirty ? '<span class="dot">●</span>' : ''}<span>${escapeHtml(name)}</span><span class="close">✕</span>`;
    el.addEventListener('click', (e) => {
      if (e.target.classList.contains('close')) closeTab(t);
      else setActiveTab(t);
    });
    tabsEl.appendChild(el);
  }
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---------- Render ----------
// Relative image paths belong to the markdown file, not to index.html, so the
// preview has to rebase them itself — it cannot use <base> without breaking the
// relative paths of its own scripts and stylesheets.
function resolveLocalImages() {
  if (!activeTab?.path) return;
  const dir = new URL('file://' + activeTab.path.replace(/[\\/][^\\/]*$/, '') + '/').href;
  preview.querySelectorAll('img[src]').forEach(img => {
    const raw = img.getAttribute('src');
    if (/^[a-z][a-z0-9+.-]*:/i.test(raw) || raw.startsWith('//')) return;
    try { img.src = new URL(raw, dir).href; } catch {}
  });
}

// mermaid.run() paints its SVGs asynchronously; the exporters await this so they
// never snapshot the preview mid-render.
let mermaidPending = Promise.resolve();

function render() {
  const src = editor ? editor.getValue() : '';
  const { body } = stripFrontMatter(src);
  preview.innerHTML = md.parse(body);
  const { headings } = md.enhance(preview);
  resolveLocalImages();

  if (window.mermaid) {
    const blocks = preview.querySelectorAll('pre code.language-mermaid, pre code.hljs.language-mermaid');
    blocks.forEach((el, i) => {
      const pre = el.closest('pre');
      const div = document.createElement('div');
      div.className = 'mermaid';
      div.id = 'mmd-' + Date.now() + '-' + i;
      div.textContent = el.textContent;
      pre.replaceWith(div);
    });
    try { mermaidPending = Promise.resolve(mermaid.run({ querySelector: '.mermaid' })); } catch {}
  }

  buildToc(headings);
  updateStats();
}

function markDirty() {
  if (!activeTab) return;
  const was = activeTab.dirty;
  activeTab.dirty = true;
  dirtyEl.textContent = '● modifié';
  if (!was) renderTabs();
  scheduleAutosave();
}
function markClean() {
  if (!activeTab) return;
  activeTab.dirty = false;
  dirtyEl.textContent = '';
  renderTabs();
}

// ---------- Stats ----------
function updateStats() {
  const text = editor ? editor.getValue() : '';
  const words = (text.trim().match(/\S+/g) || []).length;
  const chars = text.length;
  const minutes = Math.max(1, Math.round(words / 200));
  statsEl.textContent = `${words} mots · ${chars} car · ~${minutes} min lecture`;
}

// ---------- TOC ----------
// Le panneau latéral consomme la liste produite par `enhance()` : les
// identifiants sont attribués une seule fois, sinon les deux sommaires
// divergeraient.
function buildToc(headings) {
  const toc = document.getElementById('toc');
  toc.innerHTML = '';
  for (const h of headings) {
    const a = document.createElement('a');
    a.href = '#' + h.id;
    a.textContent = h.text;
    a.className = h.el.tagName.toLowerCase();
    a.addEventListener('click', (e) => {
      e.preventDefault();
      const top = h.el.getBoundingClientRect().top - preview.getBoundingClientRect().top + preview.scrollTop - 8;
      preview.scrollTo({ top, behavior: 'smooth' });
    });
    toc.appendChild(a);
  }
}

// ---------- File ops ----------
async function openFile() {
  const res = await window.api.openFile();
  if (!res) return;
  for (const f of res) openInTab({ path: f.path, content: f.content });
}

async function saveFile() {
  if (!activeTab) return;
  const saved = await window.api.saveFile({ filePath: activeTab.path, content: editor.getValue() });
  if (saved) {
    activeTab.path = saved;
    activeTab.content = editor.getValue();
    markClean();
    fileNameEl.textContent = saved.split(/[\\/]/).pop();
    window.api.watchFile(saved);
    if (folderRoot) refreshTree();
  }
}

let autosaveTimer;
function scheduleAutosave() {
  if (!document.getElementById('toggle-autosave').checked) return;
  clearTimeout(autosaveTimer);
  autosaveTimer = setTimeout(() => { if (activeTab?.path && activeTab.dirty) saveFile(); }, 2000);
}

// ---------- Folder tree ----------
async function openFolder() {
  const res = await window.api.openFolder();
  if (!res) return;
  folderRoot = res.root;
  document.getElementById('folder-name').textContent = res.root.split(/[\\/]/).pop() || res.root;
  renderTree(res.tree);
}

async function refreshTree() {
  if (!folderRoot) return;
  const res = await window.api.refreshFolder(folderRoot);
  if (res) renderTree(res.tree);
}

function renderTree(tree) {
  const container = document.getElementById('file-tree');
  container.innerHTML = '';
  container.appendChild(renderNode(tree, true));
  highlightTreeActive();
}

function renderNode(items, root) {
  const frag = document.createDocumentFragment();
  for (const item of items) {
    if (item.type === 'dir') {
      const d = document.createElement('details');
      if (root) d.open = true;
      const s = document.createElement('summary');
      s.textContent = '📁 ' + item.name;
      d.appendChild(s);
      d.appendChild(renderNode(item.children, false));
      frag.appendChild(d);
    } else {
      const f = document.createElement('div');
      f.className = 'file';
      f.textContent = '📄 ' + item.name;
      f.dataset.path = item.path;
      f.title = item.path;
      f.addEventListener('click', async () => {
        if (tabs.find(t => t.path === item.path)) { setActiveTab(tabs.find(t => t.path === item.path)); return; }
        const data = await window.api.readFile(item.path);
        openInTab({ path: data.path, content: data.content });
      });
      frag.appendChild(f);
    }
  }
  return frag;
}

function highlightTreeActive() {
  document.querySelectorAll('#file-tree .file').forEach(el => {
    el.classList.toggle('active', activeTab && el.dataset.path === activeTab.path);
  });
}

// ---------- Search ----------
const searchInput = document.getElementById('search-input');
let searchTimer;
searchInput.addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(doSearch, 250); });
async function doSearch() {
  const q = searchInput.value.trim();
  const out = document.getElementById('search-results');
  out.innerHTML = '';
  if (!folderRoot || !q) return;
  const results = await window.api.searchFolder({ root: folderRoot, query: q });
  for (const r of results) {
    const div = document.createElement('div');
    div.className = 'result';
    const snippet = escapeHtml(r.snippet).replace(new RegExp(escapeHtml(q).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), m => `<mark>${m}</mark>`);
    div.innerHTML = `<div class="path">${escapeHtml(r.rel)}</div><div class="snippet">${snippet}</div>`;
    div.addEventListener('click', async () => {
      if (tabs.find(t => t.path === r.path)) { setActiveTab(tabs.find(t => t.path === r.path)); return; }
      const data = await window.api.readFile(r.path);
      openInTab({ path: data.path, content: data.content });
    });
    out.appendChild(div);
  }
  if (!results.length) out.innerHTML = '<div style="padding:8px;color:var(--fg-muted);font-size:12px;">Aucun résultat.</div>';
}

// ---------- Sidebar tabs ----------
document.querySelectorAll('.sidebar-tabs button').forEach(b => {
  b.addEventListener('click', () => {
    document.querySelectorAll('.sidebar-tabs button').forEach(x => x.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach(x => x.classList.remove('active'));
    b.classList.add('active');
    document.getElementById('tab-' + b.dataset.tab).classList.add('active');
  });
});

// ---------- Theme ----------
const savedTheme = localStorage.getItem('theme') || 'light';
setTheme(savedTheme);
function setTheme(t) {
  document.documentElement.setAttribute('data-theme', t);
  document.getElementById('hljs-theme').href = t === 'dark'
    ? '../node_modules/highlight.js/styles/github-dark.min.css'
    : '../node_modules/highlight.js/styles/github.min.css';
  if (window.mermaid) mermaid.initialize({ startOnLoad: false, theme: t === 'dark' ? 'dark' : 'default', securityLevel: 'strict' });
  if (editor) editor.setDark(t === 'dark');
  localStorage.setItem('theme', t);
  render();
}
document.getElementById('btn-theme').addEventListener('click', () => {
  setTheme(document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark');
});

// ---------- View toggles & scroll sync ----------
const mainEl = document.querySelector('main');
const toggleEditor = document.getElementById('toggle-editor');
const toggleSync = document.getElementById('toggle-sync');
// Volet Code : décoché par défaut au démarrage, état mémorisé entre les sessions
toggleEditor.checked = localStorage.getItem('codePaneVisible') === 'true';
mainEl.classList.toggle('no-editor', !toggleEditor.checked);
toggleEditor.addEventListener('change', () => {
  mainEl.classList.toggle('no-editor', !toggleEditor.checked);
  localStorage.setItem('codePaneVisible', toggleEditor.checked);
});

// Panneau latéral : réductible via le bouton ☰, état mémorisé entre les sessions
mainEl.classList.toggle('no-sidebar', localStorage.getItem('sidebarVisible') === 'false');
document.getElementById('btn-sidebar').addEventListener('click', () => {
  const hidden = mainEl.classList.toggle('no-sidebar');
  localStorage.setItem('sidebarVisible', !hidden);
});

let syncing = false;
function syncScroll(from, to) {
  if (!toggleSync.checked || syncing) return;
  const ratio = from.scrollTop / Math.max(1, from.scrollHeight - from.clientHeight);
  syncing = true;
  to.scrollTop = ratio * Math.max(1, to.scrollHeight - to.clientHeight);
  requestAnimationFrame(() => { syncing = false; });
}
preview.addEventListener('scroll', () => { if (editor) syncScroll(preview, editor.getScrollDOM()); });

// ---------- Formatting shortcuts ----------
document.addEventListener('keydown', (e) => {
  if (!editor || !editorParent.contains(document.activeElement)) return;
  const mod = e.metaKey || e.ctrlKey;
  if (!mod) return;
  if (e.key === 'b') { e.preventDefault(); editor.wrapSelection('**', '**'); }
  else if (e.key === 'i' && !e.shiftKey) { e.preventDefault(); editor.wrapSelection('*', '*'); }
  else if (e.key === 'k' && !e.shiftKey) { e.preventDefault(); wrapLink(); }
  else if (e.key === 'u' && !e.shiftKey) { e.preventDefault(); editor.wrapSelection('<u>', '</u>'); }
  else if (['1','2','3','4','5','6'].includes(e.key) && e.altKey) { e.preventDefault(); editor.prefixLine('#'.repeat(+e.key) + ' '); }
});

function wrapLink() {
  const url = prompt('URL:', 'https://');
  if (url === null) return;
  const sel = window.getSelection()?.toString() || 'texte';
  editor.wrapSelection('[', `](${url})`);
}

// ---------- Drag & drop ----------
let dropOverlay;
document.addEventListener('dragover', (e) => {
  e.preventDefault();
  if (!dropOverlay) {
    dropOverlay = document.createElement('div');
    dropOverlay.className = 'drop-overlay';
    dropOverlay.textContent = 'Déposer le(s) fichier(s) markdown';
    document.body.appendChild(dropOverlay);
  }
});
document.addEventListener('dragleave', (e) => { if (e.relatedTarget === null) removeOverlay(); });
document.addEventListener('drop', async (e) => {
  e.preventDefault();
  removeOverlay();
  for (const file of e.dataTransfer.files) {
    if (!/\.(md|markdown|txt)$/i.test(file.name)) continue;
    const content = await file.text();
    openInTab({ path: file.path, content });
  }
});
function removeOverlay() { if (dropOverlay) { dropOverlay.remove(); dropOverlay = null; } }

// ---------- Fichiers ouverts depuis le système (double-clic, "Ouvrir avec") ----------
window.api.onOpenExternal(({ path, content }) => {
  openInTab({ path, content });
});

// ---------- Lecteur Markdown par défaut ----------
async function setDefaultReader() {
  const res = await window.api.setDefaultMarkdown();
  alert(res.message);
}

// ---------- File watcher ----------
window.api.onFileChanged(({ path, content }) => {
  const t = tabs.find(x => x.path === path);
  if (!t) return;
  if (t === activeTab && t.dirty) {
    if (!confirm(`${path.split(/[\\/]/).pop()} a changé sur disque. Recharger ?`)) return;
  }
  t.content = content;
  if (t === activeTab) {
    suppressChange = true;
    editor.setValue(content);
    suppressChange = false;
    render();
    markClean();
  }
});

// ---------- PDF / HTML export ----------
const pdfModal = document.getElementById('pdf-modal');
const PDF_FIELDS = ['pdf-page-size', 'pdf-landscape', 'pdf-margin', 'pdf-header-footer', 'pdf-break-h1', 'pdf-number-headings', 'pdf-header-text'];

// The export options are the same on almost every run; remembering them saves
// re-checking the same three boxes every time.
function loadPdfPrefs() {
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem('pdfOptions') || '{}'); } catch {}
  for (const id of PDF_FIELDS) {
    const el = document.getElementById(id);
    if (!el || !(id in saved)) continue;
    if (el.type === 'checkbox') el.checked = !!saved[id];
    else el.value = saved[id];
  }
}
function savePdfPrefs() {
  const saved = {};
  for (const id of PDF_FIELDS) {
    const el = document.getElementById(id);
    if (el) saved[id] = el.type === 'checkbox' ? el.checked : el.value;
  }
  localStorage.setItem('pdfOptions', JSON.stringify(saved));
}
loadPdfPrefs();

function readPdfOptions() {
  return {
    pageSize: document.getElementById('pdf-page-size').value,
    landscape: document.getElementById('pdf-landscape').value === 'true',
    margin: parseFloat(document.getElementById('pdf-margin').value) || 0.5,
    headerFooter: document.getElementById('pdf-header-footer').checked,
    headerText: document.getElementById('pdf-header-text').value,
    breakBeforeH1: document.getElementById('pdf-break-h1').checked,
    numberHeadings: document.getElementById('pdf-number-headings').checked,
  };
}

function showPdfModal() { pdfModal.classList.remove('hidden'); }
function hidePdfModal() { pdfModal.classList.add('hidden'); }
document.getElementById('pdf-cancel').addEventListener('click', hidePdfModal);
document.getElementById('pdf-confirm').addEventListener('click', async () => {
  const options = readPdfOptions();
  savePdfPrefs();
  hidePdfModal();
  await doExportPdf(options);
});

// KaTeX ships its fonts as `url(fonts/...)` relative to katex.min.css. Once the
// stylesheet is inlined into a standalone export those paths point nowhere, so
// rewrite them to absolute file:// URLs before handing the CSS over.
async function loadKatexCss() {
  const href = new URL('../node_modules/katex/dist/katex.min.css', location.href);
  const css = await fetch(href).then(r => r.text()).catch(() => '');
  return css.replace(/url\(([\'"]?)fonts\//g, (_m, q) => `url(${q}${new URL('fonts/', href).href}`);
}

// Chromium will happily strand a heading at the foot of a page or split a table
// across two; these are the rules that stop it, plus the two opt-in behaviours
// offered in the export dialog.
function paginationCss(options = {}) {
  return `
    h1, h2, h3, h4, h5, h6 { break-after: avoid; break-inside: avoid; }
    table, pre, blockquote, figure, img, .mermaid, .katex-display { break-inside: avoid; }
    .markdown-alert, .md-toc { break-inside: avoid; }
    .footnotes h2 { break-after: avoid; }
    tr, li { break-inside: avoid; }
    p { orphans: 3; widows: 3; }
    .page-break { break-after: page; height: 0; }
    ${options.breakBeforeH1 ? '#preview > h1, .markdown-body > h1 { break-before: page; } #preview > h1:first-child, .markdown-body > h1:first-child { break-before: auto; }' : ''}
    ${options.numberHeadings ? `
    .markdown-body { counter-reset: h1 h2 h3 h4; }
    .markdown-body h1 { counter-increment: h1; counter-reset: h2 h3 h4; }
    .markdown-body h2 { counter-increment: h2; counter-reset: h3 h4; }
    .markdown-body h3 { counter-increment: h3; counter-reset: h4; }
    .markdown-body h4 { counter-increment: h4; }
    .markdown-body h1::before { content: counter(h1) '. '; }
    .markdown-body h2::before { content: counter(h1) '.' counter(h2) '. '; }
    .markdown-body h3::before { content: counter(h1) '.' counter(h2) '.' counter(h3) '. '; }
    .markdown-body h4::before { content: counter(h1) '.' counter(h2) '.' counter(h3) '.' counter(h4) '. '; }` : ''}
  `;
}

// Relative image paths in the markdown are resolved against the document it came
// from, not against the temp file the exporter renders.
function baseTag() {
  if (!activeTab?.path) return '';
  const dir = activeTab.path.replace(/[\\/][^\\/]*$/, '');
  return `<base href="${escapeHtml(new URL('file://' + dir + '/').href)}">`;
}

function documentName() {
  return activeTab?.path ? activeTab.path.split(/[\\/]/).pop().replace(/\.[^.]+$/, '') : 'document';
}

// Everything that leaves the app — PDF, print, standalone HTML — is built from
// the preview itself rather than re-parsed, so what ships is what was on screen:
// KaTeX already typeset, mermaid already painted as SVG.
async function buildPrintableHtml(options) {
  render();
  await mermaidPending.catch(() => {});
  const [css, katexCss, hljsCss] = await Promise.all([
    fetch('styles.css').then(r => r.text()),
    loadKatexCss(),
    fetch(document.getElementById('hljs-theme').href).then(r => r.text()).catch(() => ''),
  ]);
  return `<!DOCTYPE html><html data-theme="light"><head><meta charset="utf-8"><title>${escapeHtml(documentName())}</title>${baseTag()}<style>${css}${katexCss}${hljsCss}
    body { display:block; margin: 0; } header, #tabs, #sidebar, #editor, #statusbar, .modal { display:none !important; }
    main { display: block; } #preview { padding: 0; overflow: visible; }
    ${paginationCss(options)}
  </style></head><body><div id="preview" class="markdown-body">${preview.innerHTML}</div></body></html>`;
}

async function doExportPdf(options) {
  const out = await window.api.exportPdf({ html: await buildPrintableHtml(options), defaultName: documentName(), options });
  if (out) fileNameEl.textContent = 'PDF : ' + out.split(/[\\/]/).pop();
}

async function doPrint() {
  const options = readPdfOptions();
  await window.api.print({ html: await buildPrintableHtml(options), options });
}

async function doExportHtml() {
  render();
  await mermaidPending.catch(() => {});
  const bodyHtml = preview.innerHTML;
  const css = await fetch('styles.css').then(r => r.text());
  const katexCss = await loadKatexCss();
  const hljsCss = await fetch(document.getElementById('hljs-theme').href).then(r => r.text()).catch(() => '');
  const full = `<!DOCTYPE html><html data-theme="light"><head><meta charset="utf-8"><title>${escapeHtml(activeTab?.path?.split(/[\\/]/).pop() || 'Document')}</title>${baseTag()}<style>${css}${katexCss}${hljsCss}
    body { max-width: 900px; margin: 2rem auto; padding: 0 1rem; font-family: -apple-system, Segoe UI, Roboto, sans-serif; }
    @media print { ${paginationCss(readPdfOptions())} }
  </style></head><body><div class="markdown-body">${bodyHtml}</div></body></html>`;
  const out = await window.api.exportHtml({ html: full, defaultName: documentName() });
  if (out) fileNameEl.textContent = 'HTML : ' + out.split(/[\\/]/).pop();
}

// ---------- Buttons & menus ----------
document.getElementById('btn-open').addEventListener('click', openFile);
document.getElementById('btn-open-folder').addEventListener('click', openFolder);
document.getElementById('btn-save').addEventListener('click', saveFile);
document.getElementById('btn-export').addEventListener('click', showPdfModal);
document.getElementById('btn-export-html').addEventListener('click', doExportHtml);
document.getElementById('btn-default-reader').addEventListener('click', setDefaultReader);

window.api.onMenu('menu:new', () => { newTab(); markClean(); });
window.api.onMenu('menu:open', openFile);
window.api.onMenu('menu:open-folder', openFolder);
window.api.onMenu('menu:save', saveFile);
window.api.onMenu('menu:close-tab', () => activeTab && closeTab(activeTab));
window.api.onMenu('menu:export', showPdfModal);
window.api.onMenu('menu:export-html', doExportHtml);
window.api.onMenu('menu:print', doPrint);
window.api.onMenu('menu:toggle-editor', () => { toggleEditor.checked = !toggleEditor.checked; toggleEditor.dispatchEvent(new Event('change')); });
window.api.onMenu('menu:toggle-theme', () => document.getElementById('btn-theme').click());
window.api.onMenu('menu:set-default', setDefaultReader);

// ---------- Init ----------
initEditor();
newTab({ content: `---
title: Bienvenue
---

# 🎉 MD to PDF — v3 avec CodeMirror 6

Éditeur avec coloration syntaxique, numéros de ligne, pliage, multi-curseurs, et plein d'autres bonbons.

## Essaie

- **Cmd+F** : recherche intégrée
- **Cmd+Alt+clic** : multi-curseurs
- \`Cmd+B / I / K\` : gras / italique / lien
- Plie les titres via la gouttière à gauche

## Code avec coloration

\`\`\`javascript
function fibonacci(n) {
  if (n <= 1) return n;
  return fibonacci(n - 1) + fibonacci(n - 2);
}
\`\`\`

## Maths

$$\\int_0^\\infty e^{-x^2} dx = \\frac{\\sqrt{\\pi}}{2}$$

## Diagramme

\`\`\`mermaid
sequenceDiagram
  User->>Editor: tape markdown
  Editor->>Preview: rend HTML
  Preview->>PDF: exporte
\`\`\`
` });
markClean();
