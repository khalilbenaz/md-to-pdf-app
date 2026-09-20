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
