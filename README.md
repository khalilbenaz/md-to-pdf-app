# MD to PDF

Éditeur Markdown multi-plateforme (macOS & Windows) avec aperçu en temps réel, export PDF/HTML, coloration syntaxique, KaTeX, Mermaid et thème clair/sombre.

Construit avec [Electron](https://www.electronjs.org/) + [CodeMirror 6](https://codemirror.net/) + [marked](https://marked.js.org/).

---

## ✨ Fonctionnalités

- **Éditeur CodeMirror 6** avec coloration Markdown, numéros de ligne, recherche (`Cmd/Ctrl+F`)
- **Aperçu live** synchronisé (vue partagée configurable)
- **Onglets multiples** — ouvrez plusieurs documents simultanément
- **Explorateur de dossiers** avec recherche plein-texte dans tous les `.md`
- **Surveillance de fichier** (rechargement automatique si modifié hors de l'app)
- **Export PDF** (A4/Letter, portrait/paysage, marges réglables, en-tête/pied optionnels, numéros de page)
- **Export HTML** autonome
- **Coloration syntaxique** du code (highlight.js — 190+ langages)
- **Formules mathématiques** via KaTeX (`$inline$` et `$$block$$`)
- **Diagrammes Mermaid** (flowcharts, séquence, Gantt, etc.)
- **Thème clair / sombre** (`Cmd/Ctrl+T`)
- **Zéro télémétrie**, tout est local

## ⌨️ Raccourcis clavier

| Action | Raccourci |
|---|---|
| Nouvel onglet | `Cmd/Ctrl+N` |
| Ouvrir fichier | `Cmd/Ctrl+O` |
| Ouvrir dossier | `Cmd/Ctrl+Shift+O` |
| Enregistrer | `Cmd/Ctrl+S` |
| Fermer onglet | `Cmd/Ctrl+W` |
| Export PDF | `Cmd/Ctrl+E` |
| Export HTML | `Cmd/Ctrl+Shift+E` |
| Basculer volet code | `Cmd/Ctrl+/` |
| Basculer thème | `Cmd/Ctrl+T` |
| Rechercher | `Cmd/Ctrl+F` |

---

## 📦 Installation

### Pré-requis

- [Node.js](https://nodejs.org/) **≥ 18** (recommandé 20 LTS)
- [Git](https://git-scm.com/)
- npm (inclus avec Node.js)

### Télécharger les binaires pré-construits

Les installateurs sont disponibles dans l'onglet [Releases](../../releases) du dépôt :

- **macOS** : `MD-to-PDF-<version>-arm64.dmg` (Apple Silicon) ou `MD-to-PDF-<version>-x64.dmg` (Intel)
- **Windows** : `MD-to-PDF-Setup-<version>.exe` (installateur NSIS)

---

## 🍏 Installation sur macOS (depuis les sources)

```bash
# 1. Cloner le dépôt
git clone https://github.com/khalilbenaz/md-to-pdf-app.git
cd md-to-pdf-app

# 2. Installer les dépendances
npm install

# 3. Lancer en mode développement
npm start
```

### Construire un `.dmg` pour macOS

```bash
npm run build:mac
```

Le `.dmg` est produit dans `dist/` (versions `arm64` et `x64`).

> ℹ️ **Apple Silicon vs Intel** : le build génère les deux architectures. Installez celui correspondant à votre Mac (`arm64` pour M1/M2/M3/M4, `x64` pour Intel).

> ⚠️ **Gatekeeper** : l'application n'est pas signée avec un certificat Apple Developer. Au premier lancement, faites **clic droit → Ouvrir**, puis confirmez. Pour signer et notariser, définissez les variables `CSC_LINK`, `CSC_KEY_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD` avant `npm run build:mac`.

---

## 🪟 Installation sur Windows (depuis les sources)

```powershell
# 1. Cloner le dépôt
git clone https://github.com/khalilbenaz/md-to-pdf-app.git
cd md-to-pdf-app

# 2. Installer les dépendances
npm install

# 3. Lancer en mode développement
npm start
```

### Construire un installateur `.exe` pour Windows

```powershell
npm run build:win
```

L'installateur NSIS est produit dans `dist\MD-to-PDF-Setup-<version>.exe`.

> 💡 **Windows Defender SmartScreen** : l'installateur n'étant pas signé, SmartScreen peut afficher un avertissement. Cliquez sur **Informations complémentaires → Exécuter quand même**. Pour signer, définissez `CSC_LINK` et `CSC_KEY_PASSWORD` avant le build.

> ℹ️ **Build cross-platform** : le build Windows est à exécuter sur Windows (recommandé). Le build macOS doit être exécuté sur un Mac.

---

## 🏗️ Architecture

```
md-to-pdf-app/
├── main.js              # Process principal Electron (IPC, fenêtres, export PDF/HTML)
├── preload.js           # Bridge contextIsolation entre main et renderer
├── renderer/
│   ├── index.html       # Shell UI
│   ├── styles.css       # Thèmes clair/sombre, layout
│   ├── editor-src.js    # Source CodeMirror 6 (bundlée par esbuild)
│   ├── editor-bundle.js # Bundle généré (ignoré par git)
│   └── renderer.js      # Logique UI : onglets, preview, marked, mermaid, katex
├── package.json         # Dépendances, scripts, config electron-builder
└── dist/                # Sorties de build (ignorées par git)
```

**Flux d'export PDF :**
1. Le renderer produit le HTML final (marked + highlight.js + KaTeX + Mermaid rendu en SVG).
2. Le main process charge ce HTML dans une `BrowserWindow` cachée.
3. `webContents.printToPDF()` génère le PDF via le moteur d'impression intégré.
4. Le fichier est écrit et révélé dans le Finder / l'Explorateur.

---

## 🛠️ Scripts npm

| Script | Description |
|---|---|
| `npm start` | Bundle le renderer + lance l'app en dev |
| `npm run bundle` | Bundle uniquement `editor-src.js` → `editor-bundle.js` (esbuild) |
| `npm run build` | Build des installateurs pour la plateforme courante |
| `npm run build:mac` | Build `.dmg` (arm64 + x64) |
| `npm run build:win` | Build installateur NSIS |

---

## 🐛 Dépannage

**`npm install` échoue sur `node-gyp` / binaires natifs**
→ Sur macOS : `xcode-select --install`. Sur Windows : installer les [Build Tools for Visual Studio](https://visualstudio.microsoft.com/visual-cpp-build-tools/).

**L'app s'ouvre en blanc au démarrage**
→ Vérifiez que `npm run bundle` a bien généré `renderer/editor-bundle.js`. Relancez `npm start`.

**Export PDF vide ou mal rendu**
→ Ouvrez DevTools (`Cmd/Ctrl+Shift+I`), vérifiez les erreurs dans la console du preview. Les ressources KaTeX/Mermaid doivent être chargées.

**Erreur `electron-builder` au build depuis une autre plateforme**
→ Construisez chaque cible sur sa plateforme native.

---

## 📄 Licence

[MIT](./LICENSE) © 2026 Khalil Ben Azzouz

---

## 🤝 Contribuer

Les PR sont bienvenues. Pour les changements importants, ouvrez d'abord une issue pour discuter de la proposition.
