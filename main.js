const { app, BrowserWindow, ipcMain, dialog, Menu, shell } = require('electron');
const fs = require('fs/promises');
const path = require('path');
const chokidar = require('chokidar');

let mainWindow;
let watcher = null;

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
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  const isMac = process.platform === 'darwin';
  const menu = Menu.buildFromTemplate([
    ...(isMac ? [{ role: 'appMenu' }] : []),
    {
      label: 'File',
      submenu: [
        { label: 'New Tab', accelerator: 'CmdOrCtrl+N', click: () => mainWindow.webContents.send('menu:new') },
        { label: 'Open…', accelerator: 'CmdOrCtrl+O', click: () => mainWindow.webContents.send('menu:open') },
        { label: 'Open Folder…', accelerator: 'CmdOrCtrl+Shift+O', click: () => mainWindow.webContents.send('menu:open-folder') },
        { type: 'separator' },
        { label: 'Save', accelerator: 'CmdOrCtrl+S', click: () => mainWindow.webContents.send('menu:save') },
        { label: 'Close Tab', accelerator: 'CmdOrCtrl+W', click: () => mainWindow.webContents.send('menu:close-tab') },
        { type: 'separator' },
        { label: 'Export PDF…', accelerator: 'CmdOrCtrl+E', click: () => mainWindow.webContents.send('menu:export') },
        { label: 'Export HTML…', accelerator: 'CmdOrCtrl+Shift+E', click: () => mainWindow.webContents.send('menu:export-html') },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' },
      ],
    },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { label: 'Toggle Code Pane', accelerator: 'CmdOrCtrl+/', click: () => mainWindow.webContents.send('menu:toggle-editor') },
        { label: 'Toggle Theme', accelerator: 'CmdOrCtrl+T', click: () => mainWindow.webContents.send('menu:toggle-theme') },
        { type: 'separator' },
        { role: 'reload' }, { role: 'toggleDevTools' }, { role: 'togglefullscreen' },
      ],
    },
  ]);
  Menu.setApplicationMenu(menu);
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });

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

ipcMain.handle('file:export-pdf', async (_e, { html, defaultName, options }) => {
  const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
    filters: [{ name: 'PDF', extensions: ['pdf'] }],
    defaultPath: (defaultName || 'document') + '.pdf',
  });
  if (canceled || !filePath) return null;

  const pdfWin = new BrowserWindow({ show: false, webPreferences: { sandbox: true } });
  await pdfWin.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  const m = options?.margin ?? 0.5;
  const buffer = await pdfWin.webContents.printToPDF({
    printBackground: true,
    pageSize: options?.pageSize || 'A4',
    landscape: !!options?.landscape,
    margins: { top: m, bottom: m, left: m, right: m },
    displayHeaderFooter: !!options?.headerFooter,
    headerTemplate: '<div style="font-size:8px;width:100%;text-align:center;color:#666;">' + (options?.headerText || '') + '</div>',
    footerTemplate: '<div style="font-size:8px;width:100%;text-align:center;color:#666;"><span class="pageNumber"></span> / <span class="totalPages"></span></div>',
  });
  await fs.writeFile(filePath, buffer);
  pdfWin.close();
  shell.showItemInFolder(filePath);
  return filePath;
});

ipcMain.handle('file:export-html', async (_e, { html, defaultName }) => {
  const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
    filters: [{ name: 'HTML', extensions: ['html'] }],
    defaultPath: (defaultName || 'document') + '.html',
  });
  if (canceled || !filePath) return null;
  await fs.writeFile(filePath, html, 'utf8');
  return filePath;
});
