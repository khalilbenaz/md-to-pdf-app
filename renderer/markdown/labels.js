// Français, en dur : l'interface est en français et rien ici n'est
// configurable, par décision de cadrage.
export const LABELS = {
  toc: 'Sommaire',
  figure: 'Figure',
  footnotes: 'Notes',
  // Sans `{0}`, aucune interpolation : `marked-footnote` injecte le libellé
  // BRUT de la note dans `aria-label="…"` sans l'échapper, et un libellé
  // referme la balise. On perd le numéro dans l'étiquette d'accessibilité ;
  // c'est le prix d'une injection HTML dans le fichier que l'utilisateur envoie.
  backref: 'Retour à l’appel',
  alerts: {
    note: 'Note',
    tip: 'Astuce',
    important: 'Important',
    warning: 'Attention',
    caution: 'Danger',
  },
};
