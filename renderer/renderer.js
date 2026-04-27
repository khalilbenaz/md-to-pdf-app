// ---------- Marked setup ----------
function setupMarked() {
  if (window.markedHighlight && window.hljs) {
    marked.use(window.markedHighlight.markedHighlight({
      langPrefix: 'hljs language-',
      highlight(code, lang) {
        const language = hljs.getLanguage(lang) ? lang : 'plaintext';
        return hljs.highlight(code, { language, ignoreIllegals: true }).value;
      },
    }));
  }
  if (window.markedKatex) marked.use(window.markedKatex({ throwOnError: false }));
  marked.use({ gfm: true, breaks: false });
}
if (window.hljs) setupMarked();
else window.addEventListener('hljs-ready', () => { setupMarked(); render(); });

if (window.mermaid) mermaid.initialize({ startOnLoad: false, theme: 'default', securityLevel: 'loose' });

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
function render() {
  const src = editor ? editor.getValue() : '';
  const { body } = stripFrontMatter(src);
  preview.innerHTML = marked.parse(body);

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
    try { mermaid.run({ querySelector: '.mermaid' }); } catch {}
  }

  buildToc();
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
function buildToc() {
  const toc = document.getElementById('toc');
  toc.innerHTML = '';
  preview.querySelectorAll('h1, h2, h3, h4, h5, h6').forEach((h, i) => {
    if (!h.id) h.id = 'h-' + i;
    const a = document.createElement('a');
    a.href = '#' + h.id;
    a.textContent = h.textContent;
    a.className = h.tagName.toLowerCase();
    a.addEventListener('click', (e) => {
      e.preventDefault();
      const top = h.getBoundingClientRect().top - preview.getBoundingClientRect().top + preview.scrollTop - 8;
      preview.scrollTo({ top, behavior: 'smooth' });
    });
    toc.appendChild(a);
  });
}

// ---------- File ops ----------
async function openFile() {
  const res = await window.api.openFile();
  if (!res) return;
  for (const f of res) {
    const existing = tabs.find(t => t.path === f.path);
    if (existing) setActiveTab(existing);
    else { newTab({ path: f.path, content: f.content }); markClean(); }
  }
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
        const existing = tabs.find(t => t.path === item.path);
        if (existing) setActiveTab(existing);
        else {
          const data = await window.api.readFile(item.path);
          newTab({ path: data.path, content: data.content });
          markClean();
        }
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
      const existing = tabs.find(t => t.path === r.path);
      if (existing) setActiveTab(existing);
      else {
        const data = await window.api.readFile(r.path);
        newTab({ path: data.path, content: data.content });
        markClean();
      }
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
  if (window.mermaid) mermaid.initialize({ startOnLoad: false, theme: t === 'dark' ? 'dark' : 'default', securityLevel: 'loose' });
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
toggleEditor.addEventListener('change', () => mainEl.classList.toggle('no-editor', !toggleEditor.checked));

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
    newTab({ path: file.path, content });
    markClean();
  }
});
function removeOverlay() { if (dropOverlay) { dropOverlay.remove(); dropOverlay = null; } }

// ---------- Open file from OS (double-click on .md) ----------
window.api.onOpenPath(({ path: filePath, content }) => {
  const existing = tabs.find(t => t.path === filePath);
  if (existing) { setActive(existing); return; }
  newTab({ path: filePath, content });
  markClean();
});

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
function showPdfModal() { pdfModal.classList.remove('hidden'); }
function hidePdfModal() { pdfModal.classList.add('hidden'); }
document.getElementById('pdf-cancel').addEventListener('click', hidePdfModal);
document.getElementById('pdf-confirm').addEventListener('click', async () => {
  const options = {
    pageSize: document.getElementById('pdf-page-size').value,
    landscape: document.getElementById('pdf-landscape').value === 'true',
    margin: parseFloat(document.getElementById('pdf-margin').value) || 0.5,
    headerFooter: document.getElementById('pdf-header-footer').checked,
    headerText: document.getElementById('pdf-header-text').value,
  };
  hidePdfModal();
  await doExportPdf(options);
});

async function doExportPdf(options) {
  const { body } = stripFrontMatter(editor.getValue());
  const bodyHtml = marked.parse(body);
  const css = await fetch('styles.css').then(r => r.text());
  const katexCss = await fetch('../node_modules/katex/dist/katex.min.css').then(r => r.text()).catch(() => '');
  const hljsCss = await fetch(document.getElementById('hljs-theme').href).then(r => r.text()).catch(() => '');
  const mermaidSvgs = [...preview.querySelectorAll('.mermaid svg')].map(s => s.outerHTML);
  let html = bodyHtml;
  let i = 0;
  html = html.replace(/<pre><code class="language-mermaid">[\s\S]*?<\/code><\/pre>/g, () => `<div class="mermaid">${mermaidSvgs[i++] || ''}</div>`);
  const full = `<!DOCTYPE html><html data-theme="light"><head><meta charset="utf-8"><style>${css}${katexCss}${hljsCss}
    body { display:block; margin: 0; } header, #tabs, #sidebar, #editor, #statusbar, .modal { display:none !important; }
    main { display: block; } #preview { padding: 0; overflow: visible; }
  </style></head><body><div id="preview" class="markdown-body">${html}</div></body></html>`;
  const defaultName = activeTab?.path ? activeTab.path.split(/[\\/]/).pop().replace(/\.[^.]+$/, '') : 'document';
  const out = await window.api.exportPdf({ html: full, defaultName, options });
  if (out) fileNameEl.textContent = 'PDF : ' + out.split(/[\\/]/).pop();
}

async function doExportHtml() {
  const { body } = stripFrontMatter(editor.getValue());
  const bodyHtml = marked.parse(body);
  const css = await fetch('styles.css').then(r => r.text());
  const katexCss = await fetch('../node_modules/katex/dist/katex.min.css').then(r => r.text()).catch(() => '');
  const hljsCss = await fetch(document.getElementById('hljs-theme').href).then(r => r.text()).catch(() => '');
  const full = `<!DOCTYPE html><html data-theme="light"><head><meta charset="utf-8"><title>${escapeHtml(activeTab?.path?.split(/[\\/]/).pop() || 'Document')}</title><style>${css}${katexCss}${hljsCss}
    body { max-width: 900px; margin: 2rem auto; padding: 0 1rem; font-family: -apple-system, Segoe UI, Roboto, sans-serif; }
  </style></head><body><div class="markdown-body">${bodyHtml}</div></body></html>`;
  const defaultName = activeTab?.path ? activeTab.path.split(/[\\/]/).pop().replace(/\.[^.]+$/, '') : 'document';
  const out = await window.api.exportHtml({ html: full, defaultName });
  if (out) fileNameEl.textContent = 'HTML : ' + out.split(/[\\/]/).pop();
}

// ---------- Buttons & menus ----------
document.getElementById('btn-open').addEventListener('click', openFile);
document.getElementById('btn-open-folder').addEventListener('click', openFolder);
document.getElementById('btn-save').addEventListener('click', saveFile);
document.getElementById('btn-export').addEventListener('click', showPdfModal);
document.getElementById('btn-export-html').addEventListener('click', doExportHtml);

window.api.onMenu('menu:new', () => { newTab(); markClean(); });
window.api.onMenu('menu:open', openFile);
window.api.onMenu('menu:open-folder', openFolder);
window.api.onMenu('menu:save', saveFile);
window.api.onMenu('menu:close-tab', () => activeTab && closeTab(activeTab));
window.api.onMenu('menu:export', showPdfModal);
window.api.onMenu('menu:export-html', doExportHtml);
window.api.onMenu('menu:toggle-editor', () => { toggleEditor.checked = !toggleEditor.checked; toggleEditor.dispatchEvent(new Event('change')); });
window.api.onMenu('menu:toggle-theme', () => document.getElementById('btn-theme').click());

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

// Tell main the renderer is fully wired and ready to receive file:open-path
if (window.api.notifyReady) window.api.notifyReady();
markClean();
