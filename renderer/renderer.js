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
const lotNotification = document.getElementById('lot-notification');

// I6 : l'en-tête (où vit fileNameEl) est masqué par le mode focus. Un lot
// lancé en mode focus n'affichait donc rien — ni sélecteur, ni refus. Les
// messages du lot passent par ce conteneur en plus de l'en-tête, jamais
// masqué par le mode focus.
function annoncerLot(message) {
  fileNameEl.textContent = message;
  lotNotification.textContent = message;
  lotNotification.classList.remove('hidden');
}

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
  // L'onglet de travail d'un lot en cours ne se ferme pas : la prochaine
  // itération le réactiverait alors qu'il n'existe plus dans `tabs`. Le
  // refus a lieu avant la confirmation de perte de modifications, pas après.
  if (t === tabDuLot) return;
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

// Le front-matter n'est retiré de l'aperçu que pour l'écran : la page de garde
// de l'export en a besoin.
let frontMatter = {};

function render() {
  const src = editor ? editor.getValue() : '';
  const { meta, body } = stripFrontMatter(src);
  frontMatter = meta;
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
  // L'onglet de travail d'un lot vise le fichier source en cours de
  // traitement : l'enregistrer écrirait dedans par-dessus le lot lui-même.
  if (activeTab === tabDuLot) return;
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
  // Suspendu pendant un lot : l'onglet actif est alors l'onglet de travail,
  // dont le `path` désigne un fichier source du lot — une frappe pendant le
  // lot ne doit jamais programmer une écriture dessus.
  if (lotEnCours) return;
  clearTimeout(autosaveTimer);
  autosaveTimer = setTimeout(() => { if (!lotEnCours && activeTab?.path && activeTab.dirty) saveFile(); }, 2000);
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
const PDF_FIELDS = ['pdf-page-size', 'pdf-landscape', 'pdf-margin', 'pdf-header-footer', 'pdf-break-h1', 'pdf-number-headings', 'pdf-header-text', 'pdf-cover', 'pdf-watermark'];

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
    cover: document.getElementById('pdf-cover').checked,
    watermark: document.getElementById('pdf-watermark').value,
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
    /* Le repère « saut de page » est une aide à l'écran : styles.css lui donne un
       trait pointillé et une étiquette, scopés sur l'identifiant preview, que le
       document imprimable porte aussi. Sur papier, le saut se voit de lui-même. */
    #preview .page-break { border-top: 0; margin: 0; }
    #preview .page-break::after { content: none; }
    /* Le sommaire du document exporté se présente à l'identique, rempli ou non.
       styles.css bascule le \`li\` de \`list-item\` à \`flex\` avec \`:has()\` au moment
       même où le numéro arrive : le lien devient alors un élément flexible qui
       partage la largeur avec la ligne de conduite et le numéro, et une entrée
       qui tenait sur une ligne en première passe peut passer à deux en seconde.
       La première passe mesurait donc une pagination que la seconde ne respecte
       plus — mesuré, 3 destinations sur 5 décalées d'une page sur un document de
       92 pages. Ces règles-ci sont inconditionnelles : la mise en page finale est
       déjà celle que la première passe mesure. Le \`:has()\` reste dans styles.css
       pour l'aperçu à l'écran, où il ne dit rien d'autre que ces règles.
       L'emplacement du numéro garde sa largeur même vide (min-width), sinon
       l'inscrire la reprendrait au lien. Pas d'itération des passes : c'est
       déterministe et borné ainsi, là où itérer peut ne pas converger. */
    .markdown-body .md-toc li { display: flex; align-items: baseline; gap: 0.4rem; }
    .markdown-body .md-toc li::after {
      content: ''; order: 1; flex: 1;
      border-bottom: 1px dotted var(--border); margin: 0 0.2rem 0.25rem;
    }
    .markdown-body .md-toc-page {
      order: 2; margin-left: auto; min-width: 2.2em; text-align: right;
      font-variant-numeric: tabular-nums; color: var(--fg-muted);
    }
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
    .markdown-body h4::before { content: counter(h1) '.' counter(h2) '.' counter(h3) '.' counter(h4) '. '; }
    /* Le titre de la page de garde n'est pas un chapitre : le numéroter le
       compterait, et décalerait tous les chapitres suivants d'un rang. */
    .markdown-body .pdf-cover h1 { counter-increment: none; }
    .markdown-body .pdf-cover h1::before { content: none; }` : ''}
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

// Position fixe : Chromium repeint un élément fixe sur chaque page imprimée —
// mesuré, le flux de chacune des trois pages d'un document témoin grossit.
function watermarkHtml(text) {
  const clean = (text || '').trim();
  return clean ? `<div class="pdf-watermark">${escapeHtml(clean)}</div>` : '';
}

// Une page de garde sans titre n'est qu'une page blanche : sans `title` en
// front-matter, on n'en met pas.
function coverHtml() {
  const title = frontMatter.title;
  if (!title) return '';
  const lines = [`<h1>${escapeHtml(title)}</h1>`];
  if (frontMatter.subtitle) lines.push(`<p class="pdf-cover-subtitle">${escapeHtml(frontMatter.subtitle)}</p>`);
  const meta = [frontMatter.author, frontMatter.date].filter(Boolean).map(escapeHtml);
  if (meta.length) lines.push(`<p class="pdf-cover-meta">${meta.join(' · ')}</p>`);
  return `<section class="pdf-cover">${lines.join('')}</section>`;
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
  </style></head><body>${watermarkHtml(options.watermark)}<div id="preview" class="markdown-body">${options.cover ? coverHtml() : ''}${preview.innerHTML}</div></body></html>`;
}

async function doExportPdf(options) {
  const out = await window.api.exportPdf({ html: await buildPrintableHtml(options), defaultName: documentName(), options });
  if (out) fileNameEl.textContent = 'PDF : ' + out.split(/[\\/]/).pop();
}

async function doPrint() {
  const options = readPdfOptions();
  await window.api.print({ html: await buildPrintableHtml(options), options });
}

// Même gabarit que buildPrintableHtml() : un utilisateur qui coche la page de
// garde ou remplit le filigrane doit les retrouver dans l'export HTML aussi.
// Extraite pour être testable : doExportHtml() ouvre une boîte de dialogue
// d'enregistrement, ce qu'un test ne peut pas déclencher.
async function buildExportHtml(options) {
  render();
  await mermaidPending.catch(() => {});
  const bodyHtml = preview.innerHTML;
  const css = await fetch('styles.css').then(r => r.text());
  const katexCss = await loadKatexCss();
  const hljsCss = await fetch(document.getElementById('hljs-theme').href).then(r => r.text()).catch(() => '');
  return `<!DOCTYPE html><html data-theme="light"><head><meta charset="utf-8"><title>${escapeHtml(activeTab?.path?.split(/[\\/]/).pop() || 'Document')}</title>${baseTag()}<style>${css}${katexCss}${hljsCss}
    body { max-width: 900px; margin: 2rem auto; padding: 0 1rem; font-family: -apple-system, Segoe UI, Roboto, sans-serif; }
    @media print { ${paginationCss(options)} }
  </style></head><body>${watermarkHtml(options.watermark)}<div class="markdown-body">${options.cover ? coverHtml() : ''}${bodyHtml}</div></body></html>`;
}

async function doExportHtml() {
  const options = readPdfOptions();
  const full = await buildExportHtml(options);
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

## Notes et encadrés

Une affirmation qui mérite une source[^1].

[^1]: La source en question.

> [!TIP]
> \`> [!NOTE]\`, \`[!TIP]\`, \`[!IMPORTANT]\`, \`[!WARNING]\` et \`[!CAUTION]\`
> produisent un encadré. La syntaxe \`:::note\` marche aussi.

> [!WARNING]
> Insère \`[[toc]]\` où tu veux un sommaire, et une image seule sur sa
> ligne devient une figure numérotée.

## Diagramme

\`\`\`mermaid
sequenceDiagram
  User->>Editor: tape markdown
  Editor->>Preview: rend HTML
  Preview->>PDF: exporte
\`\`\`
` });
markClean();

// ---------- Palette de commandes ----------
// `Cmd/Ctrl+K` est déjà pris par l'insertion de lien : la palette prend
// `Cmd/Ctrl+Shift+P`.
const paletteEl = document.getElementById('palette');
const paletteRequete = document.getElementById('palette-requete');
const paletteListe = document.getElementById('palette-liste');
let paletteIndex = 0;
let paletteFocusPrecedent = null;

function paletteRendu() {
  const resultats = window.commands.filtrer(paletteRequete.value);
  paletteIndex = Math.min(paletteIndex, Math.max(0, resultats.length - 1));
  paletteListe.innerHTML = '';
  resultats.forEach((c, i) => {
    const li = document.createElement('li');
    li.className = i === paletteIndex ? 'actif' : '';
    const titre = document.createElement('span');
    titre.textContent = c.titre;
    li.appendChild(titre);
    if (c.raccourci) {
      const kbd = document.createElement('kbd');
      kbd.textContent = c.raccourci;
      li.appendChild(kbd);
    }
    li.addEventListener('click', () => { fermerPalette(); window.commands.run(c.id); });
    paletteListe.appendChild(li);
  });
  return resultats;
}

function ouvrirPalette() {
  // Minor 4 : un second appel pendant que la palette est déjà ouverte
  // écrasait la mémoire du focus précédent avec `paletteRequete`
  // elle-même (activeElement à ce moment), puisqu'elle a le focus. La
  // fermeture rendait alors le focus au champ de la palette, pas à ce qui
  // l'avait avant sa toute première ouverture. Idempotent : un second appel
  // ne fait rien de plus.
  if (!paletteEl.classList.contains('hidden')) return;
  // Mémorisé pour le rendre à la fermeture, comme une boîte de dialogue :
  // ça marche quelle que soit la configuration de l'interface, sans
  // supposer que l'éditeur est visible.
  paletteFocusPrecedent = document.activeElement;
  paletteIndex = 0;
  paletteRequete.value = '';
  paletteEl.classList.remove('hidden');
  paletteRendu();
  paletteRequete.focus();
}

function estFocusable(el) {
  return !!el && el !== document.body && document.contains(el) && el.offsetParent !== null;
}

function fermerPalette() {
  paletteEl.classList.add('hidden');
  // `display: none` fait perdre le focus : sans ça, il faut recliquer dans
  // le document après chaque commande. On rend le focus à ce qui l'avait
  // avant l'ouverture ; s'il n'est plus focusable (masqué, retiré du DOM),
  // repli sur l'éditeur s'il existe.
  const precedent = paletteFocusPrecedent;
  paletteFocusPrecedent = null;
  if (estFocusable(precedent)) precedent.focus();
  else if (editor) editor.focus();
}

paletteRequete.addEventListener('input', () => { paletteIndex = 0; paletteRendu(); });
paletteRequete.addEventListener('keydown', (e) => {
  const resultats = window.commands.filtrer(paletteRequete.value);
  if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); fermerPalette(); }
  else if (e.key === 'ArrowDown') { e.preventDefault(); paletteIndex = Math.min(paletteIndex + 1, resultats.length - 1); paletteRendu(); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); paletteIndex = Math.max(paletteIndex - 1, 0); paletteRendu(); }
  else if (e.key === 'Enter') {
    e.preventDefault();
    const choisi = resultats[paletteIndex];
    fermerPalette();
    if (choisi) window.commands.run(choisi.id);
  }
});
paletteEl.addEventListener('click', (e) => { if (e.target === paletteEl) fermerPalette(); });

window.palette = { ouvrir: ouvrirPalette, fermer: fermerPalette };

document.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === 'P' || e.key === 'p')) {
    e.preventDefault();
    ouvrirPalette();
  }
});

// Les actions déjà existantes deviennent des commandes : la palette n'invente
// rien, elle rend joignable ce que les boutons et les menus font déjà.
// I5 : les raccourcis affichés étaient des littéraux `Cmd+…`, faux hors
// macOS — l'application livre aussi un installeur Windows. Le modificateur
// se déduit de la plateforme (exposée par le préchargement).
const MOD = window.api.platform === 'darwin' ? 'Cmd' : 'Ctrl';
for (const c of [
  { id: 'fichier:nouveau', titre: 'Nouvel onglet', raccourci: `${MOD}+N`, executer: () => { newTab(); markClean(); } },
  { id: 'fichier:ouvrir', titre: 'Ouvrir un fichier', raccourci: `${MOD}+O`, executer: openFile },
  { id: 'fichier:dossier', titre: 'Ouvrir un dossier', raccourci: `${MOD}+Shift+O`, executer: openFolder },
  { id: 'fichier:enregistrer', titre: 'Enregistrer', raccourci: `${MOD}+S`, executer: saveFile },
  { id: 'export:pdf', titre: 'Exporter en PDF', raccourci: `${MOD}+E`, executer: showPdfModal },
  { id: 'export:html', titre: 'Exporter en HTML', raccourci: `${MOD}+Shift+E`, executer: doExportHtml },
  { id: 'export:imprimer', titre: 'Imprimer', raccourci: `${MOD}+P`, executer: doPrint },
  { id: 'vue:code', titre: 'Afficher ou masquer le volet code', raccourci: `${MOD}+/`, executer: () => { toggleEditor.checked = !toggleEditor.checked; toggleEditor.dispatchEvent(new Event('change')); } },
  { id: 'vue:theme', titre: 'Basculer le thème clair ou sombre', raccourci: `${MOD}+T`, executer: () => document.getElementById('btn-theme').click() },
  { id: 'vue:panneau', titre: 'Afficher ou masquer le panneau latéral', executer: () => document.getElementById('btn-sidebar').click() },
]) window.commands.register(c);

// ---------- Mode focus ----------
// Volontairement non mémorisé : on entre en mode focus pour une session de
// travail, pas pour toujours.
function basculerFocus(actif) {
  const veut = actif === undefined ? !document.body.classList.contains('focus') : actif;
  document.body.classList.toggle('focus', veut);
}

window.commands.register({
  id: 'vue:focus',
  titre: 'Mode focus (masquer l’habillage)',
  executer: () => basculerFocus(),
});

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  // Un Échap par couche, la plus interne d'abord. La palette gère son propre
  // Échap sur son champ (avec stopPropagation) : si l'événement arrive
  // jusqu'ici, c'est qu'elle n'avait pas le focus. La modale PDF est la
  // couche suivante — sans ce cas, Échap en mode focus quittait le mode focus
  // et faisait réapparaître l'habillage derrière une modale restée ouverte.
  if (!pdfModal.classList.contains('hidden')) {
    e.stopPropagation();
    hidePdfModal();
    return;
  }
  // Ici on ne fait rien de plus pour éviter qu'un seul Échap ferme deux
  // couches à la fois.
  if (document.body.classList.contains('focus') && paletteEl.classList.contains('hidden')) {
    basculerFocus(false);
  }
});

// ---------- Export par lot ----------
// Deux extensions markdown différentes peuvent viser le même PDF (nom.md et
// nom.markdown) : la seconde écraserait la première en silence, et le message
// final mentirait sur le nombre de PDF réellement écrits. On détecte la
// collision avant de commencer — le premier nom rencontré gagne, les
// suivants visant le même PDF sont ignorés et comptés comme conflits.
function detecterConflitsLot(fichiers) {
  const cibles = new Set();
  const aTraiter = [];
  let conflits = 0;
  for (const nom of fichiers) {
    const pdf = nom.replace(/\.[^.]+$/, '.pdf');
    if (cibles.has(pdf)) { conflits += 1; continue; }
    cibles.add(pdf);
    aTraiter.push(nom);
  }
  return { aTraiter, conflits };
}

// Un seul onglet de travail pour tout le lot, réutilisé pour chaque fichier
// (son `path` et son contenu sont tenus à jour, dont `resolveLocalImages()`
// et `baseTag()` ont besoin pour résoudre les images relatives au bon
// dossier) — sinon un dossier de trente fichiers laisserait trente onglets
// derrière lui, l'onglet actif final noyant le document de l'utilisateur.
// Il est fermé à la fin, y compris en cas d'erreur, et la main revient à
// l'onglet d'origine. Un fichier en échec n'interrompt pas le lot, il est
// compté.
//
// Réentrance : rien dans l'interface n'empêchait un second appel pendant
// qu'un lot tournait déjà. L'onglet de travail et `activeTab` sont partagés
// par tout ce que la boucle appelle (buildPrintableHtml() lit
// `preview.innerHTML` après plusieurs `await`) : deux lots entrelacés se
// marchent dessus et un PDF peut recevoir le contenu d'un autre fichier,
// sans qu'aucun compteur ne le voie. Un second appel doit donc refuser de
// démarrer, et le dire.
let lotEnCours = false;
// L'onglet de travail vise successivement chaque fichier source du lot :
// l'enregistrement automatique (markDirty()/scheduleAutosave()) et la
// fermeture d'onglet (closeTab(), y compris via Cmd+W) le vérifient pour se
// suspendre pendant sa durée de vie.
let tabDuLot = null;

async function exporterLot() {
  if (lotEnCours) {
    annoncerLot('Un export par lot est déjà en cours');
    return;
  }
  lotEnCours = true;
  try {
    // Le lot relit chaque fichier depuis le disque : des modifications non
    // enregistrées dans un onglet quelconque seraient ignorées en silence par
    // le PDF produit. On refuse donc de démarrer plutôt que de diverger
    // silencieusement entre ce que l'utilisateur voit et ce qui est écrit.
    if (tabs.some((t) => t.dirty)) {
      annoncerLot('Enregistrez les modifications en cours avant un export par lot');
      return;
    }
    const choix = await window.api.listMarkdown();
    if (!choix) return;
    const { dossier, fichiers } = choix;
    if (!fichiers.length) {
      annoncerLot('Aucun fichier markdown dans ce dossier');
      return;
    }
    // Un chemin Windows est reconnaissable à son antislash ; sinon, `/`.
    const separateur = dossier.includes('\\') ? '\\' : '/';
    const { aTraiter, conflits } = detecterConflitsLot(fichiers);
    const options = readPdfOptions();
    const tabOrigine = activeTab;
    const tabTravail = newTab({});
    tabDuLot = tabTravail;
    let faits = 0;
    let echecs = 0;
    let remplaces = 0;
    // La spec promet des échecs « comptés et signalés » : un `catch` muet ne
    // signale rien. On journalise le fichier et l'erreur, et on nomme le
    // premier fichier fautif dans le message final — le seul qu'un
    // utilisateur pressé lira vraiment.
    let premierEchec = null;
    try {
      for (const [i, nom] of aTraiter.entries()) {
        annoncerLot(`Export ${i + 1}/${aTraiter.length} : ${nom}`);
        try {
          const chemin = dossier + separateur + nom;
          const { content } = await window.api.readFile(chemin);
          tabTravail.path = chemin;
          tabTravail.content = content;
          setActiveTab(tabTravail);
          const html = await buildPrintableHtml(options);
          const resultat = await window.api.exportPdfTo({
            html, chemin: chemin.replace(/\.[^.]+$/, '.pdf'), options,
          });
          if (resultat && resultat.remplace) remplaces += 1;
          faits += 1;
        } catch (erreur) {
          console.error(`Export par lot : échec sur ${nom}`, erreur);
          if (!premierEchec) premierEchec = nom;
          echecs += 1;
        }
      }
    } finally {
      tabDuLot = null;
      const i = tabs.indexOf(tabTravail);
      if (i !== -1) tabs.splice(i, 1);
      if (tabOrigine && tabs.includes(tabOrigine)) {
        setActiveTab(tabOrigine);
      } else if (tabs.length) {
        setActiveTab(tabs[tabs.length - 1]);
      } else {
        activeTab = null;
        suppressChange = true; editor.setValue(''); suppressChange = false;
        preview.innerHTML = '';
        fileNameEl.textContent = 'Sans titre';
        renderTabs();
      }
    }

    const dossierNom = dossier.split(separateur).pop();
    if (!remplaces && !echecs && !conflits) {
      annoncerLot(`${faits} PDF écrits dans ${dossierNom}`);
    } else {
      const morceaux = [`${faits} PDF écrits`];
      if (remplaces) morceaux.push(`${remplaces} remplacés`);
      if (echecs) morceaux.push(`${echecs} en échec (dont ${premierEchec})`);
      if (conflits) morceaux.push(`${conflits} ignorés (conflit de nom)`);
      annoncerLot(morceaux.join(', '));
    }
  } finally {
    lotEnCours = false;
  }
}

window.commands.register({
  id: 'export:lot',
  titre: 'Exporter tout un dossier en PDF',
  executer: exporterLot,
});
