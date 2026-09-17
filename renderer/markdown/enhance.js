// Passes qui s'exécutent après l'analyse : elles ont besoin d'un arbre rendu,
// donc elles vivent à part de l'analyseur et sont exercées par le test de fumée
// sous Electron plutôt que par `node --test`.
import { LABELS } from './labels.js';

// La liste retournée n'est valide que jusqu'au prochain rendu : les éléments
// qu'elle référence deviennent détachés dès que `innerHTML` est réécrit.
export function enhance(root) {
  const headings = collectHeadings(root);
  fillTableOfContents(root, headings);
  numberFigures(root);
  return { headings };
}

// Les identifiants positionnels se décalent dès qu'un titre est inséré plus
// haut, ce qui casse les ancres d'un document exporté d'une fois sur l'autre.
// Les slugs dérivés du texte sont stables et suivent la convention GitHub.
function collectHeadings(root) {
  const used = new Map();
  return [...root.querySelectorAll('h1, h2, h3, h4, h5, h6')]
    // Le `<h2>Notes</h2>` de `marked-footnote` et l'intitulé d'un sommaire déjà
    // posé sont des ornements de l'appareil de notes, pas des titres du
    // document : ils n'ont leur place ni dans le `[[toc]]` ni dans le panneau
    // latéral.
    .filter(el => !el.closest('.footnotes, .md-toc'))
    .map(el => {
      const text = el.textContent.trim();
      const level = Number(el.tagName[1]);
      // Un identifiant déjà présent est référencé ailleurs — chaque appel de
      // note porte `aria-describedby="footnote-label"` — et le réécrire ferait
      // pointer ces renvois dans le vide. On le garde, et on le réserve pour
      // qu'un titre homonyme plus bas ne le réattribue pas.
      if (el.id) {
        used.set(el.id, (used.get(el.id) || 0) + 1);
        return { id: el.id, text, level, el };
      }
      const base = slugify(text) || 'section';
      const seen = used.get(base) || 0;
      used.set(base, seen + 1);
      const id = seen ? `${base}-${seen + 1}` : base;
      el.id = id;
      return { id, text, level, el };
    });
}

const TOC_MARKER = /^\[\[toc\]\]$/i;
const TOC_MAX_LEVEL = 3;

// Un paragraphe dont le contenu entier est `[[toc]]`. Le sommaire reprend les
// titres déjà collectés : une seule source, donc pas de divergence possible
// avec le panneau latéral.
function fillTableOfContents(root, headings) {
  const doc = root.ownerDocument;
  for (const p of [...root.querySelectorAll('p')]) {
    // `textContent` aplatissait les enfants : `` `[[toc]]` `` et `**[[toc]]**`
    // passaient, donc on ne pouvait pas documenter la syntaxe sans qu'elle
    // s'exécute. Le marqueur exige un paragraphe réduit à ce seul texte.
    if (p.childNodes.length !== 1) continue;
    const seul = p.firstChild;
    if (seul.nodeType !== seul.TEXT_NODE) continue;
    // Et il ne suffit pas : `> [[toc]]` produit un `<blockquote><p>[[toc]]</p>`
    // dont le paragraphe satisfait déjà la condition ci-dessus. Le sommaire est
    // une directive de document, elle ne se reconnaît qu'au premier niveau.
    if (p.parentNode !== root) continue;
    if (!TOC_MARKER.test(seul.textContent.trim())) continue;
    const wanted = headings.filter(h => h.level <= TOC_MAX_LEVEL);
    if (!wanted.length) {
      p.remove();
      continue;
    }
    const nav = doc.createElement('nav');
    nav.className = 'md-toc';

    const title = doc.createElement('p');
    title.className = 'md-toc-title';
    title.textContent = LABELS.toc;
    nav.appendChild(title);

    const list = doc.createElement('ul');
    for (const h of wanted) {
      const li = doc.createElement('li');
      li.className = 'md-toc-h' + h.level;
      const a = doc.createElement('a');
      a.href = '#' + h.id;
      a.textContent = h.text;
      li.appendChild(a);
      list.appendChild(li);
    }
    nav.appendChild(list);
    p.replaceWith(nav);
  }
}

// Aucune syntaxe nouvelle : un paragraphe dont l'unique contenu est une image
// devient une figure. Une image sans texte alternatif ne reçoit ni légende ni
// numéro — une image décorative ne doit pas consommer un numéro de figure —
// mais reste dans un <figure> pour bénéficier des règles de saut de page.
function numberFigures(root) {
  const doc = root.ownerDocument;
  let n = 0;
  for (const p of [...root.querySelectorAll('p')]) {
    const content = [...p.childNodes].filter(
      node => node.nodeType !== node.TEXT_NODE || node.textContent.trim()
    );
    if (content.length !== 1) continue;
    const img = content[0];
    if (img.tagName !== 'IMG') continue;

    const figure = doc.createElement('figure');
    p.replaceWith(figure);
    figure.appendChild(img);

    const alt = (img.getAttribute('alt') || '').trim();
    if (!alt) continue;

    n += 1;
    const caption = doc.createElement('figcaption');
    caption.textContent = `${LABELS.figure} ${n} — ${alt}`;
    figure.appendChild(caption);
  }
}

function slugify(text) {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '');
}
