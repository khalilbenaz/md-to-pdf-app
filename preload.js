const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  openFile: () => ipcRenderer.invoke('file:open'),
  openFolder: () => ipcRenderer.invoke('folder:open'),
  refreshFolder: (root) => ipcRenderer.invoke('folder:refresh', root),
  searchFolder: (payload) => ipcRenderer.invoke('folder:search', payload),
  readFile: (p) => ipcRenderer.invoke('file:read', p),
  saveFile: (payload) => ipcRenderer.invoke('file:save', payload),
  watchFile: (p) => ipcRenderer.invoke('file:watch', p),
  exportPdf: (payload) => ipcRenderer.invoke('file:export-pdf', payload),
  exportHtml: (payload) => ipcRenderer.invoke('file:export-html', payload),
  onMenu: (channel, handler) => ipcRenderer.on(channel, handler),
  onFileChanged: (handler) => ipcRenderer.on('file:changed', (_e, data) => handler(data)),
});
