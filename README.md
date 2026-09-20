# 📕 MD to PDF

> Éditeur Markdown de bureau, multi-plateforme (macOS & Windows), avec aperçu en temps réel, export **PDF** & **HTML**, coloration syntaxique, **KaTeX**, **Mermaid** et thème clair/sombre.

![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Windows-blue)
![Electron](https://img.shields.io/badge/Electron-32-47848F?logo=electron&logoColor=white)
![CodeMirror](https://img.shields.io/badge/CodeMirror-6-d30707)
![License](https://img.shields.io/badge/license-MIT-green)
![Telemetry](https://img.shields.io/badge/télémétrie-aucune-brightgreen)

Construit avec [Electron](https://www.electronjs.org/) + [CodeMirror 6](https://codemirror.net/) + [marked](https://marked.js.org/) + [highlight.js](https://highlightjs.org/) + [KaTeX](https://katex.org/) + [Mermaid](https://mermaid.js.org/).

---

## 📑 Sommaire

- [Fonctionnalités](#-fonctionnalités)
- [Aperçu de l'interface](#-aperçu-de-linterface)
- [Lecteur Markdown par défaut](#-lecteur-markdown-par-défaut)
- [Préférences mémorisées](#-préférences-mémorisées)
- [Raccourcis clavier](#️-raccourcis-clavier)
- [Installation](#-installation)
- [Depuis les sources — macOS](#-installation-sur-macos-depuis-les-sources)
- [Depuis les sources — Windows](#-installation-sur-windows-depuis-les-sources)
- [Releases automatiques (CI)](#-releases-automatiques-ci)
- [Architecture](#️-architecture)
- [Scripts npm](#️-scripts-npm)
- [Dépannage](#-dépannage)
- [Licence](#-licence) · [Contribuer](#-contribuer)

---

## ✨ Fonctionnalités

### Édition
- **Éditeur CodeMirror 6** : coloration Markdown, numéros de ligne, pliage de titres, multi-curseurs, recherche intégrée (`Cmd/Ctrl+F`)
- **Raccourcis de formatage** : gras, italique, lien, souligné (`Cmd/Ctrl` + `B` / `I` / `K` / `U`)
- **Palette de commandes** (`Cmd/Ctrl+Shift+P`) : toutes les actions de l'application, joignables au clavier, avec recherche floue
- **Mode focus** : masque l'habillage et centre le texte sur une largeur de lecture ; `Échap` en sort, ou ferme d'abord la palette de commandes si elle est ouverte
- **Front-matter YAML** reconnu et masqué de l'aperçu (`--- title: … ---`)
- **Statistiques live** : nombre de mots, de caractères et temps de lecture estimé

### Aperçu
- **Aperçu live** rendu à chaque frappe, avec **défilement synchronisé** (activable/désactivable)
- **Coloration syntaxique** du code (highlight.js — ~45 langages courants)
- **Formules mathématiques** via KaTeX (`$inline$` et `$$block$$`)
- **Diagrammes Mermaid** (flowchart, séquence, Gantt, classe, état…)
- **Notes de bas de page** (`Texte[^1]` + `[^1]: la note`), rejetées en fin de document
- **Encadrés** `> [!NOTE]`, `[!TIP]`, `[!IMPORTANT]`, `[!WARNING]`, `[!CAUTION]` — syntaxe GitHub et Obsidian, `:::note` également accepté
- **Sommaire** inséré dans le corps du document avec `[[toc]]` (titres 1 à 3)
- **Figures numérotées** : une image seule sur sa ligne devient une figure légendée par son texte alternatif, mais une image sans texte alternatif devient une simple figure sans légende ni numéro, une image décorative ne consommant pas de numéro de figure
- **Ancres stables** : les titres reçoivent un identifiant dérivé de leur texte, pas de leur position
- **Thème clair / sombre** (`Cmd/Ctrl+T`), appliqué à l'éditeur, l'aperçu et les diagrammes
- **Images locales** : les chemins relatifs sont résolus par rapport au fichier `.md`, pas à l'application
- **Saut de page manuel** : insérez `<!-- pagebreak -->` — affiché comme un repère dans l'aperçu, appliqué à l'impression

### Gestion des fichiers
- **Onglets multiples** — plusieurs documents ouverts en parallèle, avec déduplication (un fichier déjà ouvert n'est pas rouvert en double, et un onglet vierge est réutilisé)
- **Explorateur de dossiers** avec arborescence repliable
- **Recherche plein-texte** dans tous les `.md` d'un dossier
- **Surveillance de fichier** : rechargement si le fichier est modifié hors de l'application
- **Enregistrement automatique** optionnel (autosave 2 s après la dernière modification)
- **Ouverture depuis le système** : double-clic sur un `.md` dans le Finder / l'Explorateur, ou « Ouvrir avec »
- **Lecteur Markdown par défaut** en un clic (macOS) — voir plus bas

### Export & impression
- **Export PDF** : formats A4/Letter/Legal/A3/A5, portrait/paysage, marges réglables, en-tête personnalisé et numéros de page optionnels
- **Signets PDF** : la structure des titres devient un volet de navigation dans le lecteur, et le PDF est balisé, donc accessible
- **Sommaire paginé** : un `[[toc]]` exporté porte le numéro de page réel de chaque titre, lu dans le PDF lui-même plutôt que deviné
- **Liens internes cliquables** : les entrées du sommaire et les ancres du document restent navigables dans le PDF
- **Page de garde** optionnelle, composée depuis le front-matter (`title`, `subtitle`, `author`, `date`)
- **Filigrane** optionnel, répété sur chaque page
- **Saut de page avant chaque titre 1** et **numérotation automatique des titres** (`1.`, `1.2`, `1.2.3`…), en option
- **Pagination soignée** : jamais de titre orphelin en bas de page, ni de tableau, bloc de code, formule ou diagramme coupé en deux
- **Options mémorisées** d'un export à l'autre
- **Impression directe** (`Cmd/Ctrl+P`) vers l'imprimante système
- **Export HTML** autonome : styles **et images** embarqués (data URI), le fichier reste lisible une fois envoyé à quelqu'un d'autre
- **Export par lot** : un dossier entier converti en PDF, un fichier à la fois, chaque PDF écrit à côté de son source. L'export refuse de démarrer si un onglet porte des modifications non enregistrées, pour ne jamais produire un PDF divergent de ce qui est affiché. Le message final compte les PDF écrits, ceux qui remplaçaient un PDF existant, et signale en conflit tout fichier dont le PDF cible était déjà pris par un autre (par exemple `note.md` et `note.markdown` visant le même `note.pdf` : le second est ignoré). Sa progression s'affiche dans la barre d'outils, donc elle reste invisible si l'export est lancé pendant le mode focus, qui la masque
- Les exports reprennent l'aperçu tel quel — KaTeX déjà composé, diagrammes déjà rendus en SVG

### Sécurité & confidentialité
- **Zéro télémétrie**, 100 % local — aucun appel réseau, aucune donnée ne quitte votre machine
- **Content Security Policy** stricte : un `.md` ouvert depuis l'extérieur ne peut ni exécuter de `<script>`, ni déclencher un `onerror=`, ni charger une ressource distante
- **Mermaid en `securityLevel: 'strict'`** : pas de HTML arbitraire dans les libellés de diagramme

---

## 🖥️ Aperçu de l'interface

**Barre d'outils (en-tête)**

| Bouton | Rôle |
|---|---|
| ☰ | Afficher / masquer le panneau latéral |
| 📄 Ouvrir | Ouvrir un fichier Markdown |
| 📁 Dossier | Ouvrir un dossier (explorateur + recherche) |
| 💾 Enregistrer | Enregistrer l'onglet courant |
| 📕 PDF | Exporter en PDF (ouvre les options) |
| 🌐 HTML | Exporter en HTML autonome |
| ⭐ Défaut | Définir MD to PDF comme lecteur Markdown par défaut (macOS) |
| ☑ Code | Afficher / masquer le volet éditeur |
| ☑ Sync | Synchroniser le défilement éditeur ↔ aperçu |
| ☑ Autosave | Enregistrement automatique |
| 🌓 | Basculer le thème clair / sombre |

**Panneau latéral** — trois onglets :

- **Menu** — table des matières navigable, générée depuis les titres du document
- **Fichiers** — arborescence du dossier ouvert
- **Recherche** — recherche plein-texte dans le dossier

---

## ⭐ Lecteur Markdown par défaut

MD to PDF peut s'enregistrer comme application par défaut pour les fichiers Markdown (`.md`, `.markdown`, `.mdown`, `.mkd`).

- **macOS** : cliquez sur **⭐ Défaut** dans la barre d'outils (ou menu **File → Set as Default Markdown Reader**). L'app utilise `NSWorkspace.setDefaultApplication` via le compilateur Swift système — **aucune dépendance tierce**. Fonctionne uniquement sur **l'application installée** (pas en mode `npm start`).
- Une fois défini, un double-clic sur un `.md` dans le Finder ouvre le fichier dans un nouvel onglet.

> Les associations de fichiers sont déclarées dans `package.json` (`build.fileAssociations`) et, pour macOS, dans `build.mac.extendInfo.CFBundleDocumentTypes`.

---

## 💾 Préférences mémorisées

Ces réglages sont conservés d'une session à l'autre (via `localStorage`) :

| Préférence | Défaut | Détail |
|---|---|---|
| Thème | Clair | Clair / sombre |
| Volet **Code** | **Masqué** | L'app démarre en mode aperçu ; réafficher le volet le mémorise |
| **Panneau latéral** | Visible | Réductible via ☰, état retenu |

La fenêtre s'ouvre **maximisée** au démarrage.

---

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
| Imprimer | `Cmd/Ctrl+P` |
| Palette de commandes | `Cmd/Ctrl+Shift+P` |
| Basculer volet code | `Cmd/Ctrl+/` |
| Basculer thème | `Cmd/Ctrl+T` |
| Rechercher (dans l'éditeur) | `Cmd/Ctrl+F` |
| **Gras** | `Cmd/Ctrl+B` |
| *Italique* | `Cmd/Ctrl+I` |
| Lien | `Cmd/Ctrl+K` |
| Souligné | `Cmd/Ctrl+U` |

---

## 📦 Installation

### Télécharger les binaires pré-construits

Les installateurs sont disponibles dans l'onglet [Releases](../../releases) du dépôt :

- **macOS** : `MD-to-PDF-<version>-arm64.dmg` (Apple Silicon) ou `MD-to-PDF-<version>-x64.dmg` (Intel)
- **Windows** : `MD-to-PDF-Setup-<version>.exe` (installateur NSIS)

### Pré-requis (build depuis les sources)

- [Node.js](https://nodejs.org/) **≥ 18** (recommandé 20 LTS)
- [Git](https://git-scm.com/)
- npm (inclus avec Node.js)

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

> ℹ️ **Apple Silicon vs Intel** : le build génère les deux architectures. Installez celle correspondant à votre Mac (`arm64` pour M1/M2/M3/M4, `x64` pour Intel).

> ⚠️ **Gatekeeper** : l'application n'est pas signée avec un certificat Apple Developer. Au premier lancement, faites **clic droit → Ouvrir**, puis confirmez. Pour signer et notariser, définissez `CSC_LINK`, `CSC_KEY_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD` avant `npm run build:mac`.

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

> ℹ️ **Build cross-platform** : le build Windows est à exécuter sur Windows, le build macOS sur un Mac.

---

## 🚀 Releases automatiques (CI)

Un workflow **GitHub Actions** ([`.github/workflows/release.yml`](.github/workflows/release.yml)) construit et publie automatiquement les installateurs (DMG macOS + NSIS Windows) à chaque tag de version.

```bash
# Bump de version dans package.json, puis :
git tag v1.4.0
git push origin v1.4.0
```

Le push d'un tag `v*` déclenche le build multi-OS et attache les artefacts à la Release GitHub correspondante.

---

## 🏗️ Architecture

```
md-to-pdf-app/
├── main.js                     # Process principal Electron (IPC, fenêtres, export PDF/HTML,
│                               #   ouverture système, lecteur par défaut)
├── preload.js                  # Bridge contextIsolation entre main et renderer
├── pdf.js                      # Options de rendu, lecture des destinations d'un PDF,
│                               #   remplissage des numéros de page (sans Electron)
├── renderer/
│   ├── index.html              # Shell de l'UI
│   ├── styles.css              # Thèmes clair/sombre, layout en grille
│   ├── commands.js             # Registre des commandes, source unique des actions
│   ├── editor-src.js           # Source CodeMirror 6 (bundlée par esbuild)
│   ├── editor-bundle.js        # Bundle généré (ignoré par git)
│   ├── markdown/               # Moteur de rendu : parse.js, enhance.js, labels.js, icons.js
│   ├── markdown-src.js         # Entrée navigateur du moteur (bundlée par esbuild)
│   ├── markdown-bundle.js      # Bundle généré (ignoré par git)
│   └── renderer.js             # Logique UI : onglets, aperçu, marked, mermaid, katex,
│                               #   TOC, recherche, préférences
├── build/
│   ├── icon.html               # Source de l'icône (SVG)
│   ├── make-icon.js            # Rend l'icône en PNG 1024 via Electron
│   ├── icon.png / icon.icns    # Icônes consommées par electron-builder
├── test/markdown.test.js       # Tests unitaires du moteur Markdown, sans Electron
├── test/pdf.test.js            # Tests unitaires de la chaîne PDF, sans Electron
├── test/packaging.test.js      # Cohérence du manifeste et du verrou de dépendances
├── test/smoke.js               # Test de fumée end-to-end, sous Electron
├── .github/workflows/ci.yml        # CI : test de fumée macOS / Linux / Windows
├── .github/workflows/release.yml   # CI : build & publication des installateurs
├── installer.iss               # Script Inno Setup (installateur Windows alternatif)
├── package.json                # Dépendances, scripts, config electron-builder
└── dist/                       # Sorties de build (ignorées par git)
```

**Flux d'export PDF**
1. Le renderer produit le HTML final (marked + highlight.js + KaTeX + Mermaid rendu en SVG).
2. Le main process écrit ce HTML dans un fichier temporaire et le charge dans une
   `BrowserWindow` cachée — un document `file://` peut atteindre les polices KaTeX
   et les images référencées par le markdown, ce qu'une URL `data:` ne peut pas.
3. `webContents.printToPDF()` génère le PDF via le moteur d'impression intégré de Chromium,
   avec les signets et le balisage d'accessibilité.
4. **Si le document porte un `[[toc]]`, une seconde passe a lieu.** Un numéro de page ne se
   déduit pas du DOM : `offsetTop` se trompe dès qu'une règle de pagination déplace un
   élément. Le PDF, lui, porte la réponse dans sa table de destinations. `pdf.js` la lit,
   remplit les emplacements du sommaire, et le document est rendu une seconde fois. Sans
   sommaire, la passe est sautée et l'export garde son coût d'origine.
5. Le fichier est écrit puis révélé dans le Finder / l'Explorateur.

L'impression (`Cmd/Ctrl+P`) suit le même chemin de mesure avant d'envoyer le document à la
boîte d'impression système, pour que son sommaire porte lui aussi ses numéros de page.

**Ouverture depuis le système**
- macOS envoie l'évènement `open-file` (double-clic / « Ouvrir avec »), parfois avant que le renderer soit prêt : les chemins sont mis en **file d'attente** puis rejoués une fois la fenêtre chargée.
- Une **instance unique** est garantie ; les fichiers d'un second lancement sont routés vers la fenêtre existante.

---

## 🛠️ Scripts npm

| Script | Description |
|---|---|
| `npm start` | Bundle le renderer + lance l'app en dev |
| `npm run bundle` | Bundle `renderer/editor-src.js` et `renderer/markdown-src.js` vers `editor-bundle.js` et `markdown-bundle.js` (esbuild, minifié) |
| `npm test` | Tests unitaires du moteur Markdown et de la chaîne PDF (`node --test`, sans Electron) puis test de fumée end-to-end |
| `npm run build` | Build des installateurs pour la plateforme courante |
| `npm run build:mac` | Build `.dmg` (arm64 + x64) |
| `npm run build:win` | Build installateur NSIS |

> 💡 Pour un build local rapide sans générer de `.dmg`/`.exe` : `npm run bundle && npx electron-builder --mac --dir` (produit l'app dans `dist/mac-arm64/`).

---

## 🐛 Dépannage

**`npm install` échoue sur `node-gyp` / binaires natifs**
→ macOS : `xcode-select --install`. Windows : installer les [Build Tools for Visual Studio](https://visualstudio.microsoft.com/visual-cpp-build-tools/).

**L'app s'ouvre en blanc au démarrage**
→ Vérifiez que `npm run bundle` a bien généré `renderer/editor-bundle.js`, puis relancez `npm start`.

**Export PDF vide ou mal rendu**
→ Ouvrez les DevTools (`Cmd/Ctrl+Shift+I`) et vérifiez la console de l'aperçu. Les ressources KaTeX/Mermaid doivent être chargées.

**Le bouton ⭐ Défaut ne fait rien / renvoie une erreur**
→ La fonction n'est disponible que sur **l'application installée** (pas en `npm start`). Sur macOS, autorisez l'app dans **Réglages Système → Confidentialité et sécurité** si Gatekeeper l'a bloquée.

**Erreur `electron-builder` lors d'un build cross-platform**
→ Construisez chaque cible sur sa plateforme native (DMG sur macOS, NSIS sur Windows).

---

## 📄 Licence

[MIT](./LICENSE) © 2026 Khalil Ben Azzouz

---

## 🤝 Contribuer

Les PR sont bienvenues. Pour les changements importants, ouvrez d'abord une issue pour discuter de la proposition.
