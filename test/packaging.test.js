// Ce que la chaîne de publication doit vérifier avant de produire un
// installeur : rien ici n'a besoin d'Electron, d'un navigateur ni du réseau.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const lire = (f) => JSON.parse(fs.readFileSync(path.join(root, f), 'utf8'));

test('le verrou de dépendances annonce la même version que le manifeste', () => {
  // `package-lock.json` était resté à 1.3.0 alors que `package.json` était passé
  // à 1.4.0 : electron-builder lit le manifeste, le verrou en dit autre chose,
  // et rien ne le signale. Les deux emplacements du verrou portent la version.
  const pkg = lire('package.json');
  const lock = lire('package-lock.json');
  assert.equal(lock.version, pkg.version);
  assert.equal(lock.packages[''].version, pkg.version);
  assert.equal(lock.name, pkg.name);
});

// `build.files` énumère ce qui entre dans l'archive. Un module ajouté à la
// racine et oublié dans cette liste produit un paquet qui se lance et meurt
// aussitôt sur « Cannot find module » — c'est arrivé avec `pdf.js`, ajouté au
// lot A et absent du paquet pendant deux versions. Rien ne le voyait : les
// tests s'exécutent depuis le dépôt, où le fichier est là.
function couvertParFiles(cible, motifs) {
  return motifs.some((motif) => {
    if (motif === cible) return true;
    const prefixe = motif.replace(/\*\*\/\*$/, '').replace(/\/$/, '');
    return motif.endsWith('**/*') && cible.startsWith(prefixe + '/');
  });
}

test('chaque module local requis par le processus principal entre dans le paquet', () => {
  const motifs = lire('package.json').build.files;
  const aVisiter = ['main.js', 'preload.js'];
  const vus = new Set();

  while (aVisiter.length) {
    const fichier = aVisiter.shift();
    if (vus.has(fichier)) continue;
    vus.add(fichier);

    assert.ok(
      couvertParFiles(fichier, motifs),
      `${fichier} est requis mais n'est couvert par aucun motif de build.files : ${motifs.join(', ')}`,
    );

    const source = fs.readFileSync(path.join(root, fichier), 'utf8');
    for (const m of source.matchAll(/require\(['"](\.\/[^'"]+)['"]\)/g)) {
      const cible = path.posix.join(path.posix.dirname(fichier), m[1]).replace(/^\.\//, '');
      aVisiter.push(cible.endsWith('.js') ? cible : cible + '.js');
    }
  }
});
