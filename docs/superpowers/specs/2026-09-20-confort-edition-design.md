# Durcissement du harnais et confort d'édition

**Date** : 20 septembre 2026
**Statut** : auto-approuvé (run autopilot), écrit avant toute ligne de code
**Version cible** : 1.5.0
**Lots précédents** : `2026-09-17-markdown-extensions-design.md` (B, v1.3.0), `2026-09-17-chaine-pdf-design.md` (A, v1.4.0)

## Contexte

Deux choses motivent ce lot.

**Le harnais de test laisse des applications ouvertes sur la machine.** Depuis
le lot A, `test/smoke.js` charge `main.js` pour exercer les vrais handlers
d'export. `main.js` ouvre alors la fenêtre principale. Quand une exécution de
`npm test` est interrompue — deux fois par une limite de session pendant le lot
A — la fenêtre reste ouverte : l'utilisateur a retrouvé **deux processus
Electron orphelins dans son Dock**, rattachés à un worktree supprimé depuis.
Une relecture l'avait signalé et je l'avais classé « sans effet sur la CI ».
C'était vrai et hors sujet : l'effet était sur la machine de l'utilisateur.

**L'éditeur n'a pas avancé.** Les deux lots précédents ont porté sur le rendu
et sur le PDF. L'usage quotidien, lui, n'a rien gagné.

## Ce qui existe déjà, vérifié avant de concevoir

| Supposé manquant | Réalité |
|---|---|
| Synchro d'aperçu bidirectionnelle | **Déjà là** — aperçu → éditeur (`renderer.js:372`) et éditeur → aperçu (`renderer.js:44`), avec garde de réentrance |
| Volet code repliable, panneau latéral repliable | Déjà là, état mémorisé |
| Recherche dans le dossier | Déjà là |

La synchro sort donc du périmètre. Elle est calée sur un ratio de défilement,
ce qui est grossier mais fonctionne ; l'améliorer serait du confort, pas une
correction, et ce lot a déjà quatre chantiers.

## Décisions

| Sujet | Décision |
|---|---|
| Orphelins de test | Le test neutralise la surface Electron **avant** de charger `main.js` |
| Chien de garde | Le test s'arrête de lui-même au-delà d'un délai, quoi qu'il arrive |
| Verrou d'instance | Neutralisé dans le test, jamais dans l'application |
| Palette de commandes | Registre de commandes maison, sans dépendance |
| Mode focus | Masque l'habillage, centre le texte, `Échap` en sort |
| Export par lot | Un dossier entier vers des PDF, dans le processus principal |
| Découpe de `renderer.js` | Le registre de commandes sort dans son propre module |

**Aucune modification de l'application pour les besoins du test.** Pas de
variable d'environnement lue par `main.js`, pas de branche « si test ». Le
harnais s'arrange avec la surface publique d'Electron, qu'il contrôle
entièrement puisqu'il s'exécute avant le chargement de `main.js`.

## Architecture

### A — Durcissement du harnais

Trois mesures dans `test/smoke.js`, aucune dans l'application.

1. **Aucune fenêtre d'application.** Le test remplace `app.whenReady` par une
   promesse qui ne déclenche pas les rappels enregistrés par `main.js`, avant
   de le charger. `createWindow()` n'est donc jamais appelée, et les handlers
   IPC — le seul but du chargement — sont tout de même enregistrés.
2. **Chien de garde.** Un minuteur armé au démarrage appelle `app.exit(1)` au
   bout de trois minutes. Une exécution interrompue, bloquée, ou qui perdrait
   son parent ne peut plus survivre indéfiniment. Le minuteur est désarmé à la
   sortie normale.
3. **Verrou d'instance neutralisé.** `app.requestSingleInstanceLock` rend
   toujours vrai pendant le test, de sorte que `npm test` ne s'interrompe pas
   parce que l'application est ouverte sur la machine.

### B — Palette de commandes

`renderer/commands.js` (bundlé) porte un **registre** : chaque commande est un
objet `{ id, titre, raccourci, executer }`.

**Ce que le registre est réellement, pas ce qu'il devrait être** : seule la
palette le lit (`filtrer()`, `run()`). Les boutons de l'en-tête gardent leurs
propres écouteurs (`btn-open`, `btn-save`, …), les menus leurs propres canaux
IPC (`menu:open`, `menu:save`, …), et les accélérateurs restent déclarés en
dur dans `main.js`. Le champ `raccourci` de chaque commande n'est qu'un
libellé affiché dans la liste — rien ne le relie au raccourci clavier
réellement actif ailleurs dans l'application, et rien ne détecte un doublon
entre les deux. « L'interface et les menus s'y abonnent » décrivait
l'intention, pas ce qui a été livré : recâbler boutons, menus et
accélérateurs sur le registre reste du travail à faire, dans un autre lot.

`Cmd/Ctrl+K` ouvre un champ de recherche floue sur les titres. `↑` `↓`
naviguent, `Entrée` exécute, `Échap` ferme. La liste affiche le raccourci
quand la commande en a un.

Intérêt au-delà du confort : les commandes deviennent énumérables, donc
testables sans cliquer.

### C — Mode focus

Masque l'en-tête, le panneau latéral, les onglets et la barre d'état ; centre
la colonne de texte à une largeur de lecture. `Échap` ou la commande en
ressort. L'état n'est pas mémorisé : on entre en mode focus pour une session
de travail, pas pour toujours.

### D — Export par lot

Une commande demande un dossier, puis exporte chaque `.md` qu'il contient en
PDF, à côté du fichier source. Le processus principal réutilise le chemin
d'export existant, y compris la double passe du sommaire.

Chaque document doit être rendu dans l'aperçu pour produire son HTML : le lot
boucle donc côté renderer, un fichier après l'autre, et rend la main au
processus principal pour chaque écriture. La barre d'état affiche la
progression. Un fichier en échec n'interrompt pas le lot : il est compté et
signalé à la fin.

## Périmètre

**Dans le lot** : les quatre chantiers ci-dessus, le registre de commandes, la
documentation et la version.

**Hors du lot** : mise à jour automatique et tenue sur très gros documents
(lot D, sous-système à part) ; synchro d'aperçu calée sur le contenu plutôt
que sur un ratio ; export par lot récursif dans les sous-dossiers.

## Risques

| Risque | Parade |
|---|---|
| Neutraliser `app.whenReady` empêche aussi le test de démarrer | Le test attend la vraie promesse avant de charger `main.js`, et n'intercepte que les rappels que `main.js` enregistre ensuite |
| Le chien de garde masque un blocage réel en le transformant en échec | Il sort en code 1 avec un message explicite, jamais en succès |
| L'export par lot bloque l'interface sur un gros dossier | Un fichier à la fois, progression affichée, annulable en fermant la fenêtre |
| La palette double des raccourcis existants | Non paré : le registre n'est pas la source unique (voir section B), rien ne détecte aujourd'hui un doublon entre le libellé affiché dans la palette et un raccourci réellement actif ailleurs |
