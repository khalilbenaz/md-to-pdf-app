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
