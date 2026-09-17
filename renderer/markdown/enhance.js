// Passes qui s'exécutent après l'analyse : elles ont besoin d'un arbre rendu,
// donc elles vivent à part de l'analyseur et sont exercées par le test de fumée
// sous Electron plutôt que par `node --test`.
import { LABELS } from './labels.js';

export function enhance(root) {
  const headings = collectHeadings(root);
  return { headings };
}

// Les identifiants positionnels se décalent dès qu'un titre est inséré plus
// haut, ce qui casse les ancres d'un document exporté d'une fois sur l'autre.
// Les slugs dérivés du texte sont stables et suivent la convention GitHub.
function collectHeadings(root) {
  const used = new Map();
  return [...root.querySelectorAll('h1, h2, h3, h4, h5, h6')].map(el => {
    const text = el.textContent.trim();
    const base = slugify(text) || 'section';
    const seen = used.get(base) || 0;
    used.set(base, seen + 1);
    const id = seen ? `${base}-${seen + 1}` : base;
    el.id = id;
    return { id, text, level: Number(el.tagName[1]), el };
  });
}

function slugify(text) {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '');
}
