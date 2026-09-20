const { app, BrowserWindow, ipcMain, dialog, Menu, shell } = require('electron');
const fs = require('fs/promises');
const { existsSync } = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const chokidar = require('chokidar');
const { pdfOptions, hasTocSlots, tocSecondPass } = require('./pdf.js');

let mainWindow;
let watcher = null;

// Extensions markdown reconnues par l'application (doivent rester alignées avec
// "fileAssociations" dans package.json).
const MD_EXTENSIONS = ['md', 'markdown', 'mdown', 'mkd'];
const MD_EXT_RE = new RegExp('\\.(' + MD_EXTENSIONS.join('|') + '|txt)$', 'i');

// File d'attente des fichiers à ouvrir tant que la fenêtre n'est pas prête
// (macOS envoie l'évènement open-file avant que le renderer ne soit chargé).
let pendingFiles = [];
let rendererReady = false;

async function openPathInRenderer(filePath) {
  if (!filePath) return;
  if (!rendererReady || !mainWindow) { pendingFiles.push(filePath); return; }
  try {
    const content = await fs.readFile(filePath, 'utf8');
    mainWindow.webContents.send('file:open-external', { path: filePath, content });
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  } catch (e) {
    dialog.showMessageBox(mainWindow, {
      type: 'error',
      message: 'Impossible d\'ouvrir le fichier',
      detail: filePath + '\n\n' + e.message,
    });
  }
}

function filesFromArgv(argv) {
  // Sur Windows/Linux, le chemin du fichier est passé en argument de ligne de commande.
  return argv
    .slice(1)
    .filter((a) => !a.startsWith('-') && MD_EXT_RE.test(a) && existsSync(a));
}

function flushPendingFiles() {
  const queued = pendingFiles;
  pendingFiles = [];
  for (const f of queued) openPathInRenderer(f);
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 800,
    minHeight: 500,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow.maximize();
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  mainWindow.webContents.once('did-finish-load', () => {
    rendererReady = true;
    // Fichiers passés au premier lancement (double-clic sous Windows/Linux).
    for (const f of filesFromArgv(process.argv)) pendingFiles.push(f);
    flushPendingFiles();
  });

  const isMac = process.platform === 'darwin';
  const menu = Menu.buildFromTemplate([
    ...(isMac ? [{
      label: app.name,
      submenu: [
        { label: `À propos de ${app.name}`, role: 'about' },
        { type: 'separator' },
        { label: 'Services', role: 'services' },
        { type: 'separator' },
        { label: `Masquer ${app.name}`, role: 'hide' },
        { label: 'Masquer les autres', role: 'hideOthers' },
        { label: 'Tout afficher', role: 'unhide' },
        { type: 'separator' },
        { label: `Quitter ${app.name}`, role: 'quit' },
      ],
    }] : []),
    // Le reste de l'interface est en français ; les libellés de rôles sont
    // forcés eux aussi, sinon ils suivent la langue du système.
    {
      label: 'Fichier',
      submenu: [
        { label: 'Nouvel onglet', accelerator: 'CmdOrCtrl+N', click: () => mainWindow.webContents.send('menu:new') },
        { label: 'Ouvrir…', accelerator: 'CmdOrCtrl+O', click: () => mainWindow.webContents.send('menu:open') },
        { label: 'Ouvrir un dossier…', accelerator: 'CmdOrCtrl+Shift+O', click: () => mainWindow.webContents.send('menu:open-folder') },
        { type: 'separator' },
        { label: 'Enregistrer', accelerator: 'CmdOrCtrl+S', click: () => mainWindow.webContents.send('menu:save') },
        { label: 'Fermer l\'onglet', accelerator: 'CmdOrCtrl+W', click: () => mainWindow.webContents.send('menu:close-tab') },
        { type: 'separator' },
        { label: 'Exporter en PDF…', accelerator: 'CmdOrCtrl+E', click: () => mainWindow.webContents.send('menu:export') },
        { label: 'Exporter en HTML…', accelerator: 'CmdOrCtrl+Shift+E', click: () => mainWindow.webContents.send('menu:export-html') },
        { label: 'Imprimer…', accelerator: 'CmdOrCtrl+P', click: () => mainWindow.webContents.send('menu:print') },
        { type: 'separator' },
        { label: 'Définir comme lecteur Markdown par défaut', click: () => mainWindow.webContents.send('menu:set-default') },
        { type: 'separator' },
        isMac ? { label: 'Fermer la fenêtre', role: 'close' } : { label: 'Quitter', role: 'quit' },
      ],
    },
    {
      label: 'Édition',
      submenu: [
        { label: 'Annuler', role: 'undo' },
        { label: 'Rétablir', role: 'redo' },
        { type: 'separator' },
        { label: 'Couper', role: 'cut' },
        { label: 'Copier', role: 'copy' },
        { label: 'Coller', role: 'paste' },
        ...(isMac ? [{ label: 'Coller et adapter le style', role: 'pasteAndMatchStyle' }] : []),
        { label: 'Supprimer', role: 'delete' },
        { label: 'Tout sélectionner', role: 'selectAll' },
      ],
    },
    {
      label: 'Affichage',
      submenu: [
        { label: 'Afficher/masquer le volet code', accelerator: 'CmdOrCtrl+/', click: () => mainWindow.webContents.send('menu:toggle-editor') },
        { label: 'Basculer le thème', accelerator: 'CmdOrCtrl+T', click: () => mainWindow.webContents.send('menu:toggle-theme') },
        { type: 'separator' },
        { label: 'Zoom avant', role: 'zoomIn' },
        { label: 'Zoom arrière', role: 'zoomOut' },
        { label: 'Taille réelle', role: 'resetZoom' },
        { type: 'separator' },
        { label: 'Recharger', role: 'reload' },
        { label: 'Outils de développement', role: 'toggleDevTools' },
        { label: 'Plein écran', role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Fenêtre',
      submenu: [
        { label: 'Réduire', role: 'minimize' },
        ...(isMac ? [{ label: 'Placer en zoom', role: 'zoom' }, { type: 'separator' }, { label: 'Tout ramener au premier plan', role: 'front' }] : []),
      ],
    },
  ]);
  Menu.setApplicationMenu(menu);
}

// macOS : fichier ouvert via Finder / "Ouvrir avec". Peut arriver avant `ready`.
app.on('open-file', (event, filePath) => {
  event.preventDefault();
  openPathInRenderer(filePath);
});

// Une seule instance : les fichiers d'un second lancement sont routés vers la fenêtre existante.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
    for (const f of filesFromArgv(argv)) openPathInRenderer(f);
  });

  app.whenReady().then(createWindow);
  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
}

// ─── Définir l'application comme lecteur Markdown par défaut ────────────────────

function macAppBundlePath() {
  const exe = app.getPath('exe');
  const marker = '.app/';
  const idx = exe.indexOf(marker);
  return idx !== -1 ? exe.slice(0, idx + marker.length - 1) : null;
}

// macOS : utilise NSWorkspace.setDefaultApplication (Launch Services) via le
// compilateur Swift système. Aucune dépendance tierce.
function setDefaultMac() {
  return new Promise((resolve) => {
    if (!app.isPackaged) {
      resolve({
        ok: false,
        message: 'Disponible uniquement dans l\'application installée.\n\n'
          + 'Lancez « MD to PDF » depuis le dossier Applications, puis réessayez.',
      });
      return;
    }
    const bundle = macAppBundlePath();
    if (!bundle) {
      resolve({ ok: false, message: 'Chemin de l\'application introuvable.' });
      return;
    }

    const swiftSrc = `
import AppKit
import UniformTypeIdentifiers

let env = ProcessInfo.processInfo.environment
guard let appPath = env["MDP_APP_PATH"] else {
  FileHandle.standardError.write("chemin app manquant".data(using: .utf8)!); exit(2)
}
let exts = (env["MDP_EXTS"] ?? "").split(separator: ",").map(String.init)
let appURL = URL(fileURLWithPath: appPath)
let ws = NSWorkspace.shared
var errors: [String] = []
for ext in exts {
  guard let type = UTType(filenameExtension: ext) else {
    errors.append("\\(ext): type inconnu"); continue
  }
  let sem = DispatchSemaphore(value: 0)
  ws.setDefaultApplication(at: appURL, toOpen: type) { error in
    if let error = error { errors.append("\\(ext): \\(error.localizedDescription)") }
    sem.signal()
  }
  sem.wait()
}
if errors.isEmpty { print("OK") }
else { FileHandle.standardError.write(errors.joined(separator: "; ").data(using: .utf8)!); exit(1) }
`;

    const child = spawn('swift', ['-'], {
      env: {
        ...process.env,
        MDP_APP_PATH: bundle,
        MDP_EXTS: MD_EXTENSIONS.join(','),
      },
    });
    let stderr = '';
    child.on('error', (err) => {
      resolve({
        ok: false,
        message: 'Le compilateur Swift est introuvable.\n\n'
          + 'Vous pouvez définir MD to PDF comme lecteur par défaut manuellement :\n'
          + 'clic droit sur un fichier .md → Lire les informations → Ouvrir avec → '
          + 'MD to PDF → Tout modifier.\n\n(' + err.message + ')',
      });
    });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('close', (code) => {
      if (code === 0) {
        resolve({
          ok: true,
          message: 'MD to PDF est maintenant le lecteur par défaut pour les fichiers '
            + MD_EXTENSIONS.map((e) => '.' + e).join(', ') + '.',
        });
      } else {
        resolve({
          ok: false,
          message: 'Impossible de définir l\'application par défaut.\n\n' + (stderr.trim() || 'Erreur inconnue.'),
        });
      }
    });
    child.stdin.write(swiftSrc);
    child.stdin.end();
  });
}

async function setAsDefaultMarkdownHandler() {
  if (process.platform === 'darwin') return setDefaultMac();
  if (process.platform === 'win32') {
    // Windows 10+ interdit de forcer l'association par défaut sans l'utilisateur.
    await shell.openExternal('ms-settings:defaultapps');
    return {
      ok: false,
      message: 'Windows exige de choisir l\'application par défaut manuellement.\n\n'
        + 'Dans Paramètres → Applications par défaut, choisissez « MD to PDF » pour les fichiers .md.',
    };
  }
  return { ok: false, message: 'Fonction non prise en charge sur cette plateforme.' };
}

ipcMain.handle('app:set-default-md', () => setAsDefaultMarkdownHandler());

ipcMain.handle('file:open', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
    filters: [{ name: 'Markdown', extensions: ['md', 'markdown', 'txt'] }],
    properties: ['openFile', 'multiSelections'],
  });
  if (canceled || !filePaths.length) return null;
  const files = [];
  for (const p of filePaths) files.push({ path: p, content: await fs.readFile(p, 'utf8') });
  return files;
});

ipcMain.handle('file:read', async (_e, filePath) => {
  const content = await fs.readFile(filePath, 'utf8');
  return { path: filePath, content };
});

ipcMain.handle('file:save', async (_e, { filePath, content }) => {
  let target = filePath;
  if (!target) {
    const { canceled, filePath: chosen } = await dialog.showSaveDialog(mainWindow, {
      filters: [{ name: 'Markdown', extensions: ['md'] }],
      defaultPath: 'document.md',
    });
    if (canceled || !chosen) return null;
    target = chosen;
  }
  await fs.writeFile(target, content, 'utf8');
  return target;
});

ipcMain.handle('folder:open', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
  });
  if (canceled || !filePaths[0]) return null;
  return buildTree(filePaths[0]);
});

ipcMain.handle('folder:refresh', async (_e, root) => buildTree(root));

async function buildTree(root) {
  async function walk(dir) {
    let entries;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); }
    catch { return []; }
    const items = [];
    for (const e of entries) {
      if (e.name.startsWith('.') || e.name === 'node_modules' || e.name === 'dist') continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        const children = await walk(full);
        if (children.length) items.push({ type: 'dir', name: e.name, path: full, children });
      } else if (e.isFile() && /\.(md|markdown)$/i.test(e.name)) {
        items.push({ type: 'file', name: e.name, path: full });
      }
    }
    items.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    return items;
  }
  return { root, tree: await walk(root) };
}

ipcMain.handle('folder:search', async (_e, { root, query }) => {
  if (!query || !root) return [];
  const q = query.toLowerCase();
  const matches = [];
  async function walk(dir) {
    let entries;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); }
    catch { return; }
    for (const e of entries) {
      if (e.name.startsWith('.') || e.name === 'node_modules' || e.name === 'dist') continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) await walk(full);
      else if (e.isFile() && /\.(md|markdown)$/i.test(e.name)) {
        try {
          const content = await fs.readFile(full, 'utf8');
          const lower = content.toLowerCase();
          const idx = lower.indexOf(q);
          if (idx >= 0) {
            const start = Math.max(0, idx - 40);
            const end = Math.min(content.length, idx + q.length + 40);
            matches.push({
              path: full,
              rel: path.relative(root, full),
              snippet: (start > 0 ? '…' : '') + content.slice(start, end).replace(/\n/g, ' ') + (end < content.length ? '…' : ''),
            });
            if (matches.length >= 100) return;
          }
        } catch {}
      }
    }
  }
  await walk(root);
  return matches;
});

ipcMain.handle('file:watch', async (_e, filePath) => {
  if (watcher) { await watcher.close(); watcher = null; }
  if (!filePath) return;
  watcher = chokidar.watch(filePath, { ignoreInitial: true });
  watcher.on('change', async () => {
    try {
      const content = await fs.readFile(filePath, 'utf8');
      mainWindow.webContents.send('file:changed', { path: filePath, content });
    } catch {}
  });
});

// Chromium resolves nothing from a data: URL, so every export renders from a
// real file on disk instead. Callers get the path and must clean it up.
async function stageHtml(html) {
  const file = path.join(app.getPath('temp'), `mdtopdf-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.html`);
  await fs.writeFile(file, html, 'utf8');
  return file;
}

ipcMain.handle('file:print', async (_e, { html, options }) => {
  const win = new BrowserWindow({ show: false, webPreferences: { sandbox: true } });
  let staged;
  let restaged;
  try {
    staged = await stageHtml(html);
    await win.loadFile(staged);
    // « Enregistrer au format PDF » depuis la boîte système est un geste courant
    // sous macOS : l'impression fait donc la même mesure que l'export, sinon le
    // même document donne un sommaire aux emplacements vides d'un côté et
    // rempli de l'autre, sans que rien ne le signale. Le PDF de la mesure n'est
    // pas conservé — c'est la fenêtre rechargée qui part à l'impression. Sans
    // emplacement à remplir, il n'y a rien à mesurer et la passe est sautée.
    if (hasTocSlots(html)) {
      const mesure = await win.webContents.printToPDF(pdfOptions(options));
      const { needed, html: numbered } = tocSecondPass(html, mesure);
      if (needed) {
        restaged = await stageHtml(numbered);
        await win.loadFile(restaged);
      }
    }
    const m = options?.margin ?? 0.5;
    await new Promise((resolve) => {
      win.webContents.print({
        printBackground: true,
        landscape: !!options?.landscape,
        pageSize: options?.pageSize || 'A4',
        margins: { marginType: 'custom', top: m, bottom: m, left: m, right: m },
      }, () => resolve());
    });
  } finally {
    // Sans ce `finally`, un `loadFile` en échec — deux ERR_FAILED relevés en
    // revue — laissait la fenêtre cachée vivante jusqu'à la fermeture de
    // l'application et le fichier temporaire sur le disque, à chaque tentative.
    // Ce fichier porte le document entier, images en data URI comprises.
    // Les suppressions d'abord, `close()` isolé ensuite : sur une fenêtre déjà
    // détruite, `close()` lève et emporterait le ménage avec lui.
    if (staged) await fs.unlink(staged).catch(() => {});
    if (restaged) await fs.unlink(restaged).catch(() => {});
    try { win.close(); } catch {}
  }
  return true;
});

ipcMain.handle('file:export-pdf', async (_e, { html, defaultName, options }) => {
  const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
    filters: [{ name: 'PDF', extensions: ['pdf'] }],
    defaultPath: (defaultName || 'document') + '.pdf',
  });
  if (canceled || !filePath) return null;

  const stagedHtml = await stageHtml(html);
  const pdfWin = new BrowserWindow({ show: false, webPreferences: { sandbox: true } });
  let restaged;
  try {
    await pdfWin.loadFile(stagedHtml);
    // Les numéros de page ne s'obtiennent que du PDF lui-même : `offsetTop` se
    // trompe dès qu'une règle de pagination déplace un élément. On rend donc une
    // première fois pour savoir, puis une seconde pour montrer. Sans sommaire,
    // rien à remplir et la seconde passe est sautée.
    let buffer = await pdfWin.webContents.printToPDF(pdfOptions(options));
    const { needed, html: numbered } = tocSecondPass(html, buffer);
    if (needed) {
      restaged = await stageHtml(numbered);
      await pdfWin.loadFile(restaged);
      buffer = await pdfWin.webContents.printToPDF(pdfOptions(options));
    }
    await fs.writeFile(filePath, buffer);
  } finally {
    // Les suppressions avant la fermeture : sur une fenêtre déjà détruite,
    // `close()` lève, et les fichiers temporaires restaient alors sur le disque.
    await fs.unlink(stagedHtml).catch(() => {});
    if (restaged) await fs.unlink(restaged).catch(() => {});
    try { pdfWin.close(); } catch {}
  }
  shell.showItemInFolder(filePath);
  return filePath;
});

// L'export par lot boucle côté renderer — chaque document doit passer par
// l'aperçu pour produire son HTML — et revient ici pour chaque écriture. D'où
// un handler qui écrit à un chemin donné, sans boîte de dialogue.
ipcMain.handle('file:export-pdf-to', async (_e, { html, chemin, options }) => {
  const stagedHtml = await stageHtml(html);
  const pdfWin = new BrowserWindow({ show: false, webPreferences: { sandbox: true } });
  let restaged = null;
  try {
    await pdfWin.loadFile(stagedHtml);
    let buffer = await pdfWin.webContents.printToPDF(pdfOptions(options));
    if (hasTocSlots(html)) {
      const pass = tocSecondPass(html, buffer);
      if (pass.needed) {
        restaged = await stageHtml(pass.html);
        await pdfWin.loadFile(restaged);
        buffer = await pdfWin.webContents.printToPDF(pdfOptions(options));
      }
    }
    await fs.writeFile(chemin, buffer);
    return { chemin };
  } finally {
    await fs.unlink(stagedHtml).catch(() => {});
    if (restaged) await fs.unlink(restaged).catch(() => {});
    try { pdfWin.close(); } catch {}
  }
});

ipcMain.handle('folder:list-markdown', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
    title: 'Dossier à exporter en PDF',
  });
  if (canceled || !filePaths.length) return null;
  const dossier = filePaths[0];
  const entrees = await fs.readdir(dossier, { withFileTypes: true });
  // `MD_EXT_RE` accepte aussi `.txt`, pour l'ouverture manuelle. Un export par
  // lot ne doit prendre que du markdown : on filtre sur `MD_EXTENSIONS`.
  const estMarkdown = new RegExp('\\.(' + MD_EXTENSIONS.join('|') + ')$', 'i');
  const fichiers = entrees
    .filter((e) => e.isFile() && estMarkdown.test(e.name))
    .map((e) => e.name)
    .sort();
  return { dossier, fichiers };
});

const MIME_BY_EXT = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.svg': 'image/svg+xml', '.webp': 'image/webp', '.bmp': 'image/bmp', '.avif': 'image/avif',
};

// An exported .html carrying file:// image paths breaks the moment it is sent to
// someone else, so the images travel with it.
async function inlineLocalImages(html) {
  const seen = new Map();
  const matches = [...html.matchAll(/src="(file:\/\/[^"]+)"/g)];
  for (const [, url] of matches) {
    if (seen.has(url)) continue;
    try {
      const file = decodeURIComponent(new URL(url).pathname);
      const mime = MIME_BY_EXT[path.extname(file).toLowerCase()];
      if (!mime) continue;
      const data = await fs.readFile(file);
      seen.set(url, `data:${mime};base64,${data.toString('base64')}`);
    } catch {}
  }
  for (const [url, dataUri] of seen) html = html.split(`src="${url}"`).join(`src="${dataUri}"`);
  return html;
}

ipcMain.handle('file:export-html', async (_e, { html, defaultName }) => {
  const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
    filters: [{ name: 'HTML', extensions: ['html'] }],
    defaultPath: (defaultName || 'document') + '.html',
  });
  if (canceled || !filePath) return null;
  await fs.writeFile(filePath, await inlineLocalImages(html), 'utf8');
  return filePath;
});
