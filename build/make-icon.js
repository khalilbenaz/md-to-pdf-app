const { app, BrowserWindow } = require('electron');
const path = require('path'), fs = require('fs/promises');
app.whenReady().then(async () => {
  const w = new BrowserWindow({ width: 1024, height: 1024, show: false, transparent: true, frame: false,
    webPreferences: { offscreen: false }, backgroundColor: '#00000000' });
  await w.loadFile(path.join(__dirname, 'icon.html'));
  await new Promise(r => setTimeout(r, 600));
  const img = await w.webContents.capturePage();
  await fs.writeFile(path.join(__dirname, 'icon-1024.png'), img.toPNG());
  console.log('ICON_OK');
  app.exit(0);
});
