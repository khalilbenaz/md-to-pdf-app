# Durcissement du harnais et confort d'édition : plan d'implémentation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Empêcher le harnais de test de laisser des fenêtres ouvertes sur la machine, puis donner à l'éditeur une palette de commandes, un mode focus et un export par lot.

**Architecture:** Le durcissement ne touche que `test/smoke.js` : il neutralise la surface Electron avant de charger `main.js`, et s'arme d'un chien de garde. Côté application, un registre de commandes dans `renderer/commands.js` devient la source unique des actions ; la palette, le mode focus et l'export par lot s'y déclarent au lieu de câbler des écouteurs un par un.

**Tech Stack:** Electron 32, `node:test`, aucune dépendance nouvelle.

**Spec:** `docs/superpowers/specs/2026-09-20-confort-edition-design.md`

## Global Constraints

- **Aucune branche de test dans l'application.** Pas de variable d'environnement lue par `main.js`, pas de `if (test)`. Le harnais s'arrange avec la surface publique d'Electron.
- **Aucune dépendance nouvelle.**
- `Cmd/Ctrl+K` est déjà pris : il insère un lien (`renderer.js`, gestionnaire de raccourcis de formatage). La palette prend **`Cmd/Ctrl+Shift+P`**.
- Les sélecteurs CSS des éléments de contenu visent `.markdown-body`, jamais `#preview` : l'export HTML n'enveloppe pas dans `#preview`. Les éléments d'interface (palette, mode focus) ne sont pas du contenu et se scopent sur leur propre classe.
- Libellés en français, en dur.
- La CSP est stricte : aucune ressource distante, aucun script inline.
- Appelle git par son chemin absolu `/usr/bin/git` : un hook réécrit `git` en `rtk git`, que la garde d'isolation du worktree refuse.
- Chaque commande shell doit être **simple** : une commande par appel, pas de `cd x && y`, pas de `bash <script>`.
- Tout nouveau bloc de `test/smoke.js` qui réécrit `preview.innerHTML` s'ajoute à la FIN du fichier, juste avant `const failed = results.filter(...)`.
- Baseline : 34 tests unitaires, 73 vérifications de fumée. Aucune ne doit disparaître.

---

### Task 1: Durcir le harnais de test

Le seul chantier qui répare un dégât constaté : l'utilisateur a retrouvé deux processus Electron orphelins dans son Dock, rattachés à un worktree supprimé.

**Files:**
- Modify: `test/smoke.js`

**Interfaces:**
- Consumes: rien.
- Produces: rien pour les tâches suivantes.

- [ ] **Step 1: Écrire les vérifications qui échouent**

Dans `test/smoke.js`, le bloc qui charge `main.js` commence par le commentaire « ── I2 / I3 : les deux handlers du processus principal ── ». Juste AVANT `const handlers = {};`, insérer le relevé du nombre de fenêtres :

```js
  // `main.js` ouvre la fenêtre principale sur `app.whenReady`. Si le test la
  // laisse s'ouvrir et qu'une exécution est interrompue — deux fois pendant le
  // lot A, par une limite de session — elle survit au test et reste dans le
  // Dock de l'utilisateur, rattachée à un worktree parfois déjà supprimé.
  const fenetresAvant = BrowserWindow.getAllWindows().length;
```

Et juste APRÈS `ipcMain.handle = vraiHandle;`, remplacer :

```js
  await new Promise((r) => setTimeout(r, 1500));
```

par :

```js
  await new Promise((r) => setTimeout(r, 300));
  check('charger main.js n’ouvre aucune fenêtre d’application',
    BrowserWindow.getAllWindows().length === fenetresAvant,
    `avant ${fenetresAvant}, après ${BrowserWindow.getAllWindows().length}`);
```

- [ ] **Step 2: Lancer et voir échouer**

Run: `npm test`
Expected: FAIL sur `charger main.js n’ouvre aucune fenêtre d’application` — `main.js` en ouvre une.

- [ ] **Step 3: Neutraliser la surface Electron avant le chargement**

Remplacer les trois lignes qui chargent `main.js` :

```js
  const handlers = {};
  const vraiHandle = ipcMain.handle.bind(ipcMain);
  ipcMain.handle = (channel, fn) => { handlers[channel] = fn; try { vraiHandle(channel, fn); } catch {} };
  require(path.join(root, 'main.js'));
  ipcMain.handle = vraiHandle;
```

par :

```js
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
```

- [ ] **Step 4: Lancer et voir passer**

Run: `npm test`
Expected: 34 tests unitaires PASS, `74/74 checks passed` (73 + 1)

- [ ] **Step 5: Armer le chien de garde**

En tête de `test/smoke.js`, après `const results = [];`, ajouter :

```js
// Une exécution interrompue — limite de session, terminal fermé, blocage —
// laissait le processus Electron vivant. Il se saborde désormais de lui-même.
const DELAI_MAX_MS = 3 * 60 * 1000;
const chienDeGarde = setTimeout(() => {
  console.error(`\nFAIL le test a dépassé ${DELAI_MAX_MS / 1000} s, arrêt forcé`);
  app.exit(1);
}, DELAI_MAX_MS);
```

À la fin du fichier, juste avant `app.exit(failed.length ? 1 : 0);`, ajouter :

```js
  clearTimeout(chienDeGarde);
```

Le fichier se termine par un `.catch(err => { console.error('harness error:', err); app.exit(1); })` : y ajouter `clearTimeout(chienDeGarde);` avant son `app.exit(1)`.

- [ ] **Step 6: Vérifier que le chien de garde ne gêne pas une exécution normale**

Run: `npm test`
Expected: 34 tests unitaires PASS, `74/74 checks passed`, et le processus rend la main immédiatement après.

- [ ] **Step 7: Vérifier qu'il ne reste aucun processus**

Run: `pgrep -fl "Electron" | grep -c autopilot-confort-edition`
Expected: `0`

- [ ] **Step 8: Commit**

```bash
/usr/bin/git add -A
/usr/bin/git commit -m "test: le harnais n'ouvre plus de fenêtre et se saborde au-delà de trois minutes"
```

---

### Task 2: Registre de commandes et palette

**Files:**
- Create: `renderer/commands.js`
- Modify: `renderer/index.html`
- Modify: `renderer/renderer.js`
- Modify: `renderer/styles.css`
- Modify: `test/smoke.js`

**Interfaces:**
- Consumes: rien.
- Produces:
  - `window.commands.register({ id, titre, raccourci, executer })`
  - `window.commands.all() → Array<{ id, titre, raccourci, executer }>`
  - `window.commands.run(id) → boolean`
  - `window.commands.filtrer(requete) → Array` — correspondance floue sur le titre
  - `window.palette.ouvrir()` / `window.palette.fermer()`

- [ ] **Step 1: Écrire les vérifications qui échouent**

Ajouter à la FIN de `test/smoke.js`, juste avant `const failed = results.filter(...)` :

```js
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
```

- [ ] **Step 2: Lancer et voir échouer**

Run: `npm test`
Expected: FAIL — `window.commands` n'existe pas.

- [ ] **Step 3: Créer `renderer/commands.js`**

Script classique, chargé avant `renderer.js`. Pas de bundle : il n'importe rien.

```js
// Registre des commandes de l'application. Source unique : l'interface, les
// menus et la palette s'y abonnent au lieu de câbler des écouteurs un par un,
// ce qui rend aussi les actions énumérables — donc testables sans cliquer.
(() => {
  const registre = [];

  function register(commande) {
    if (!commande || !commande.id || typeof commande.executer !== 'function') return;
    const existant = registre.findIndex((c) => c.id === commande.id);
    if (existant >= 0) registre[existant] = commande;
    else registre.push(commande);
  }

  function all() {
    return registre.slice();
  }

  function run(id) {
    const c = registre.find((x) => x.id === id);
    if (!c) return false;
    c.executer();
    return true;
  }

  // Correspondance floue : les lettres de la requête doivent apparaître dans
  // l'ordre, pas forcément côte à côte. « cmddm » retrouve « Commande de
  // démonstration ».
  function correspond(titre, requete) {
    const t = titre.toLowerCase();
    const r = requete.toLowerCase().replace(/\s+/g, '');
    let i = 0;
    for (const ch of t) {
      if (ch === r[i]) i += 1;
      if (i === r.length) return true;
    }
    return r.length === 0;
  }

  function filtrer(requete) {
    if (!requete) return all();
    return registre.filter((c) => correspond(c.titre, requete));
  }

  window.commands = { register, all, run, filtrer };
})();
```

- [ ] **Step 4: Ajouter la palette au balisage**

Dans `renderer/index.html`, juste avant `<script src="../node_modules/mermaid/dist/mermaid.min.js"></script>`, ajouter :

```html
  <div id="palette" class="hidden">
    <div class="palette-boite">
      <input type="text" id="palette-requete" placeholder="Rechercher une commande…" autocomplete="off" />
      <ul id="palette-liste"></ul>
    </div>
  </div>
```

Et charger le registre avant `renderer.js`, après `editor-bundle.js` :

```html
  <script src="commands.js"></script>
```

- [ ] **Step 5: Câbler la palette dans `renderer.js`**

Ajouter à la fin de `renderer/renderer.js` :

```js
// ---------- Palette de commandes ----------
// `Cmd/Ctrl+K` est déjà pris par l'insertion de lien : la palette prend
// `Cmd/Ctrl+Shift+P`.
const paletteEl = document.getElementById('palette');
const paletteRequete = document.getElementById('palette-requete');
const paletteListe = document.getElementById('palette-liste');
let paletteIndex = 0;

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
  paletteIndex = 0;
  paletteRequete.value = '';
  paletteEl.classList.remove('hidden');
  paletteRendu();
  paletteRequete.focus();
}

function fermerPalette() {
  paletteEl.classList.add('hidden');
}

paletteRequete.addEventListener('input', () => { paletteIndex = 0; paletteRendu(); });
paletteRequete.addEventListener('keydown', (e) => {
  const resultats = window.commands.filtrer(paletteRequete.value);
  if (e.key === 'Escape') { e.preventDefault(); fermerPalette(); }
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
for (const c of [
  { id: 'fichier:nouveau', titre: 'Nouvel onglet', raccourci: 'Cmd+N', executer: () => { newTab(); markClean(); } },
  { id: 'fichier:ouvrir', titre: 'Ouvrir un fichier', raccourci: 'Cmd+O', executer: openFile },
  { id: 'fichier:dossier', titre: 'Ouvrir un dossier', raccourci: 'Cmd+Shift+O', executer: openFolder },
  { id: 'fichier:enregistrer', titre: 'Enregistrer', raccourci: 'Cmd+S', executer: saveFile },
  { id: 'export:pdf', titre: 'Exporter en PDF', raccourci: 'Cmd+E', executer: showPdfModal },
  { id: 'export:html', titre: 'Exporter en HTML', raccourci: 'Cmd+Shift+E', executer: doExportHtml },
  { id: 'export:imprimer', titre: 'Imprimer', raccourci: 'Cmd+P', executer: doPrint },
  { id: 'vue:code', titre: 'Afficher ou masquer le volet code', raccourci: 'Cmd+/', executer: () => { toggleEditor.checked = !toggleEditor.checked; toggleEditor.dispatchEvent(new Event('change')); } },
  { id: 'vue:theme', titre: 'Basculer le thème clair ou sombre', raccourci: 'Cmd+T', executer: () => document.getElementById('btn-theme').click() },
  { id: 'vue:panneau', titre: 'Afficher ou masquer le panneau latéral', executer: () => document.getElementById('btn-sidebar').click() },
]) window.commands.register(c);
```

- [ ] **Step 6: Habiller la palette**

Ajouter à la fin de `renderer/styles.css` :

```css
/* ---------- Palette de commandes ---------- */
#palette {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.35);
  display: flex;
  justify-content: center;
  align-items: flex-start;
  padding-top: 12vh;
  z-index: 1000;
}
#palette.hidden { display: none; }
#palette .palette-boite {
  width: min(560px, 90vw);
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 10px;
  box-shadow: 0 16px 48px rgba(0, 0, 0, 0.3);
  overflow: hidden;
}
#palette input {
  width: 100%;
  border: 0;
  border-bottom: 1px solid var(--border);
  padding: 0.9rem 1rem;
  font-size: 1rem;
  background: var(--bg);
  color: var(--fg);
  outline: none;
}
#palette ul { list-style: none; margin: 0; padding: 0.3rem; max-height: 50vh; overflow-y: auto; }
#palette li {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  padding: 0.5rem 0.75rem;
  border-radius: 6px;
  cursor: pointer;
  color: var(--fg);
}
#palette li.actif { background: var(--accent); color: var(--accent-fg); }
#palette li kbd {
  font-size: 0.78em;
  color: var(--fg-muted);
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 0.05rem 0.35rem;
}
#palette li.actif kbd { color: var(--accent-fg); border-color: var(--accent-fg); }
```

- [ ] **Step 7: Lancer et voir passer**

Run: `npm test`
Expected: 34 tests unitaires PASS, `80/80 checks passed` (74 + 6)

- [ ] **Step 8: Commit**

```bash
/usr/bin/git add -A
/usr/bin/git commit -m "feat: registre de commandes et palette (Cmd+Shift+P)"
```

---

### Task 3: Mode focus

**Files:**
- Modify: `renderer/renderer.js`
- Modify: `renderer/styles.css`
- Modify: `test/smoke.js`

**Interfaces:**
- Consumes: `window.commands.register` de la tâche 2.
- Produces: la classe `focus` sur `<body>`, la commande `vue:focus`.

- [ ] **Step 1: Écrire les vérifications qui échouent**

Ajouter à la FIN de `test/smoke.js`, juste avant `const failed = results.filter(...)` :

```js
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
```

- [ ] **Step 2: Lancer et voir échouer**

Run: `npm test`
Expected: FAIL — la commande `vue:focus` n'existe pas.

- [ ] **Step 3: Implémenter**

Ajouter à la fin de `renderer/renderer.js` :

```js
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
  raccourci: 'Échap pour sortir',
  executer: () => basculerFocus(),
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && document.body.classList.contains('focus')) {
    basculerFocus(false);
  }
});
```

- [ ] **Step 4: Habiller**

Ajouter à la fin de `renderer/styles.css` :

```css
/* ---------- Mode focus ---------- */
body.focus header,
body.focus #tabs,
body.focus #sidebar,
body.focus #statusbar { display: none !important; }
body.focus #preview {
  max-width: 46rem;
  margin: 0 auto;
  padding: 3rem 1.5rem;
}
```

- [ ] **Step 5: Lancer et voir passer**

Run: `npm test`
Expected: 34 tests unitaires PASS, `84/84 checks passed` (80 + 4)

- [ ] **Step 6: Commit**

```bash
/usr/bin/git add -A
/usr/bin/git commit -m "feat: mode focus"
```

---

### Task 4: Export par lot d'un dossier

**Files:**
- Modify: `main.js`
- Modify: `preload.js`
- Modify: `renderer/renderer.js`
- Modify: `test/smoke.js`

**Interfaces:**
- Consumes: `window.commands.register` (tâche 2), `buildPrintableHtml()` et `readPdfOptions()` (existants), `stageHtml`, `pdfOptions`, `tocSecondPass`, `hasTocSlots` (existants dans `main.js` et `pdf.js`).
- Produces:
  - IPC `folder:list-markdown` → `{ dossier, fichiers: string[] }` ou `null` si annulé
  - IPC `file:export-pdf-to` → `{ chemin }` — écrit sans boîte de dialogue
  - commande `export:lot`

- [ ] **Step 1: Écrire les vérifications qui échouent**

Ajouter à la FIN de `test/smoke.js`, juste avant `const failed = results.filter(...)`. Le handler d'écriture directe se teste par la référence capturée, comme les autres handlers du processus principal :

```js
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
```

- [ ] **Step 2: Lancer et voir échouer**

Run: `npm test`
Expected: FAIL — les deux handlers et la commande n'existent pas.

- [ ] **Step 3: Ajouter les deux handlers dans `main.js`**

Après le handler `file:export-pdf`, ajouter :

```js
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
```

- [ ] **Step 4: Exposer les deux canaux dans `preload.js`**

Après `exportPdf`, ajouter :

```js
  exportPdfTo: (payload) => ipcRenderer.invoke('file:export-pdf-to', payload),
  listMarkdown: () => ipcRenderer.invoke('folder:list-markdown'),
```

- [ ] **Step 5: Implémenter la commande dans `renderer.js`**

Ajouter à la fin de `renderer/renderer.js` :

```js
// ---------- Export par lot ----------
// Un fichier à la fois : chaque document doit passer par l'aperçu pour
// produire son HTML. Un échec n'interrompt pas le lot, il est compté.
async function exporterLot() {
  const choix = await window.api.listMarkdown();
  if (!choix) return;
  const { dossier, fichiers } = choix;
  if (!fichiers.length) {
    fileNameEl.textContent = 'Aucun fichier markdown dans ce dossier';
    return;
  }
  const options = readPdfOptions();
  let faits = 0;
  let echecs = 0;
  for (const [i, nom] of fichiers.entries()) {
    fileNameEl.textContent = `Export ${i + 1}/${fichiers.length} : ${nom}`;
    try {
      const chemin = dossier + '/' + nom;
      const { content } = await window.api.readFile(chemin);
      newTab({ path: chemin, content });
      const html = await buildPrintableHtml(options);
      await window.api.exportPdfTo({ html, chemin: chemin.replace(/\.[^.]+$/, '.pdf'), options });
      faits += 1;
    } catch {
      echecs += 1;
    }
  }
  fileNameEl.textContent = echecs
    ? `${faits} PDF écrits, ${echecs} en échec`
    : `${faits} PDF écrits dans ${dossier.split('/').pop()}`;
}

window.commands.register({
  id: 'export:lot',
  titre: 'Exporter tout un dossier en PDF',
  executer: exporterLot,
});
```

- [ ] **Step 6: Lancer et voir passer**

Run: `npm test`
Expected: 34 tests unitaires PASS, `88/88 checks passed` (84 + 4)

- [ ] **Step 7: Commit**

```bash
/usr/bin/git add -A
/usr/bin/git commit -m "feat: export par lot d'un dossier en PDF"
```

---

### Task 5: Documentation et version

**Files:**
- Modify: `README.md`
- Modify: `package.json`
- Modify: `package-lock.json`

**Interfaces:**
- Consumes: tout ce qui précède.
- Produces: rien.

- [ ] **Step 1: Documenter dans le README**

Dans la section « Édition », après la ligne des raccourcis de formatage, ajouter :

```markdown
- **Palette de commandes** (`Cmd/Ctrl+Shift+P`) : toutes les actions de l'application, joignables au clavier, avec recherche floue
- **Mode focus** : masque l'habillage et centre le texte sur une largeur de lecture, `Échap` pour en sortir
```

Dans la section « Export & impression », après la ligne de l'export HTML, ajouter :

```markdown
- **Export par lot** : un dossier entier converti en PDF, un fichier à la fois, chaque PDF écrit à côté de son source
```

Dans le tableau des raccourcis, après la ligne « Imprimer », ajouter :

```markdown
| Palette de commandes | `Cmd/Ctrl+Shift+P` |
```

Dans la section « Architecture », après la ligne de `styles.css`, ajouter :

```markdown
│   ├── commands.js             # Registre des commandes, source unique des actions
```

- [ ] **Step 2: Passer la version à 1.5.0**

Dans `package.json`, remplacer `"version": "1.4.0"` par `"version": "1.5.0"`.
Dans `package-lock.json`, faire de même aux deux endroits qui portent la version du paquet racine (`.version` et `.packages[""].version`), sans lancer d'installation qui reformaterait le fichier. Le test `test/packaging.test.js` vérifie que les deux restent d'accord.

- [ ] **Step 3: Vérifier une dernière fois**

Run: `npm test`
Expected: 34 tests unitaires PASS, `88/88 checks passed`

- [ ] **Step 4: Commit**

```bash
/usr/bin/git add -A
/usr/bin/git commit -m "docs: documente la palette, le mode focus et l'export par lot, version 1.5.0"
```
