// Registre des commandes de l'application, lu par la palette de commandes.
// Les boutons de l'en-tête et les menus gardent leurs propres écouteurs et
// canaux IPC — ce registre ne les remplace pas encore. Intérêt déjà acquis :
// les commandes qui y sont déclarées deviennent énumérables, donc testables
// sans cliquer.
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
    // Minor 3 : un `executer` asynchrone qui rejette n'était ni attrapé ni
    // signalé (rejet de promesse invisible). On enveloppe l'appel, pour les
    // échecs synchrones comme pour les rejets asynchrones.
    try {
      const resultat = c.executer();
      if (resultat && typeof resultat.catch === 'function') {
        resultat.catch((erreur) => console.error(`Commande "${id}" a échoué`, erreur));
      }
    } catch (erreur) {
      console.error(`Commande "${id}" a échoué`, erreur);
    }
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
