// Tout ce que la chaîne PDF sait calculer sans Electron. Isolé ici pour être
// exerçable par `node --test` : le reste de l'export a besoin d'un navigateur.

// Mesuré sur Electron 32 : `generateDocumentOutline` seul ne produit aucun
// signet, il lui faut l'arbre de structure du PDF balisé. Les deux ne se
// séparent pas. Le balisage rend au passage le PDF accessible.
function pdfOptions(options = {}) {
  const m = options.margin ?? 0.5;
  return {
    printBackground: true,
    pageSize: options.pageSize || 'A4',
    landscape: !!options.landscape,
    margins: { top: m, bottom: m, left: m, right: m },
    displayHeaderFooter: !!options.headerFooter,
    headerTemplate: '<div style="font-size:8px;width:100%;text-align:center;color:#666;">' + (options.headerText || '') + '</div>',
    footerTemplate: '<div style="font-size:8px;width:100%;text-align:center;color:#666;"><span class="pageNumber"></span> / <span class="totalPages"></span></div>',
    generateDocumentOutline: true,
    generateTaggedPDF: true,
  };
}

// Un nom PDF échappe hors de l'ASCII imprimable en `#XX`, octet par octet.
// Mais Chromium nomme ses destinations d'après le fragment d'URL, qui est
// **percent-encodé** : le `%` lui-même est ensuite échappé en `#25`. Relevé
// brut sur un vrai PDF : `/p#25C3#25A9rim#25C3#25A8tre-2026`. Le décodage
// `#XX` seul rend donc `p%C3%A9rimètre-2026`… soit `p%C3%A9rim%C3%A8tre-2026`,
// qu'aucun `data-target` ne contient. Il faut défaire les deux couches.
function decodePdfName(name) {
  const bytes = [];
  for (let i = 0; i < name.length; i++) {
    if (name[i] === '#' && /^[0-9a-f]{2}$/i.test(name.slice(i + 1, i + 3))) {
      bytes.push(parseInt(name.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      bytes.push(name.charCodeAt(i));
    }
  }
  const decoded = Buffer.from(bytes).toString('utf8');
  // Une séquence `%` invalide ne doit pas faire échouer la lecture entière :
  // cette entrée-là perd son numéro de page, les autres gardent le leur.
  try {
    return decodeURIComponent(decoded);
  } catch {
    return decoded;
  }
}

// Un objet de page porte des sous-dictionnaires (/Resources, /Group) : chercher
// le premier `>>` tronquerait le dictionnaire avant son /Kids. On équilibre.
function balancedDict(raw, open) {
  let depth = 0;
  for (let i = open; i < raw.length - 1; i++) {
    if (raw[i] === '<' && raw[i + 1] === '<') { depth += 1; i += 1; continue; }
    if (raw[i] === '>' && raw[i + 1] === '>') {
      depth -= 1;
      i += 1;
      if (depth === 0) return raw.slice(open + 2, i - 1);
    }
  }
  return null;
}

// Table `numéro d'objet → corps de son dictionnaire`, dans l'ordre textuel.
// Première définition gagnante : Chromium écrit son PDF en une passe, et une
// occurrence fortuite de « N 0 obj » dans un flux binaire ne doit pas écraser
// un vrai objet.
function objectDicts(raw) {
  const dicts = new Map();
  for (const m of raw.matchAll(/(\d+)\s+\d+\s+obj\b/g)) {
    const num = Number(m[1]);
    if (dicts.has(num)) continue;
    const start = m.index + m[0].length;
    const end = raw.indexOf('endobj', start);
    const open = raw.indexOf('<<', start);
    if (open === -1 || (end !== -1 && open > end)) continue;
    const dict = balancedDict(raw, open);
    if (dict !== null) dicts.set(num, dict);
  }
  return dicts;
}

function kidsOf(dict) {
  const kids = dict.match(/\/Kids\s*\[([^\]]*)\]/);
  return kids ? [...kids[1].matchAll(/(\d+)\s+\d+\s+R/g)].map((k) => Number(k[1])) : [];
}

// Un PDF malformé — ou forgé — peut refermer son arbre sur lui-même. La borne
// de profondeur et l'ensemble des objets déjà visités garantissent l'arrêt.
const MAX_PAGE_TREE_DEPTH = 64;

function walkPageTree(num, dicts, out, seen, depth) {
  if (depth > MAX_PAGE_TREE_DEPTH || seen.has(num)) return;
  seen.add(num);
  const dict = dicts.get(num);
  if (dict === undefined) return;
  if (/\/Type\s*\/Pages\b/.test(dict)) {
    for (const kid of kidsOf(dict)) walkPageTree(kid, dicts, out, seen, depth + 1);
    return;
  }
  if (/\/Type\s*\/Page\b/.test(dict)) { out.push(num); return; }
  // Un nœud sans /Type : c'est son /Kids qui tranche.
  const kids = kidsOf(dict);
  if (kids.length) for (const kid of kids) walkPageTree(kid, dicts, out, seen, depth + 1);
  else out.push(num);
}

// L'ordre de lecture du document est celui des feuilles de l'arbre de pages,
// parcouru depuis la racine. Prendre le PREMIER objet `/Type /Pages` porteur
// d'un `/Kids` ne marche que tant que l'arbre est plat : mesuré, Skia n'aplatit
// que jusqu'à 8 pages, au-delà il construit un arbre à plusieurs niveaux dont le
// premier nœud rencontré textuellement est une FEUILLE. Tout ce qui suit
// obtenait alors `indexOf() === -1` — 5 destinations sur 60 pour un document de
// 92 pages. On descend donc depuis /Root (ou /Type /Catalog) → /Pages → /Kids.
// Deux replis conservés : l'ancien nœud /Kids, puis l'ordre d'apparition
// textuelle des objets de page.
function pageOrderOf(raw) {
  const dicts = objectDicts(raw);

  let root = null;
  for (const m of raw.matchAll(/\/Root\s+(\d+)\s+\d+\s+R/g)) root = Number(m[1]);
  if (root === null || !dicts.has(root)) {
    root = null;
    for (const [num, dict] of dicts) {
      if (/\/Type\s*\/Catalog\b/.test(dict)) { root = num; break; }
    }
  }

  if (root !== null) {
    const pagesRef = dicts.get(root).match(/\/Pages\s+(\d+)\s+\d+\s+R/);
    if (pagesRef) {
      const order = [];
      walkPageTree(Number(pagesRef[1]), dicts, order, new Set(), 0);
      if (order.length) return order;
    }
  }

  for (const dict of dicts.values()) {
    if (/\/Type\s*\/Pages\b/.test(dict)) {
      const order = kidsOf(dict);
      if (order.length) return order;
    }
  }

  return [...raw.matchAll(/(\d+) 0 obj\s*<<[^>]*?\/Type\s*\/Page[^s]/g)].map((m) => Number(m[1]));
}

// Chromium nomme ses destinations d'après les identifiants d'ancre du document
// et n'emploie pas de flux d'objets : la table est lisible telle quelle. Rendre
// un objet vide plutôt que lever, pour qu'un changement de Chromium coûte des
// numéros de page absents et non un export en échec.
//
// Le résultat est sans prototype : un titre « Constructor » donne la cible
// `constructor`, et `pages[target]` rendrait alors la fonction héritée d'Object.
function destinationPages(pdfBuffer) {
  const raw = Buffer.isBuffer(pdfBuffer) ? pdfBuffer.toString('latin1') : String(pdfBuffer);

  const pages = Object.create(null);

  const pageOrder = pageOrderOf(raw);
  if (!pageOrder.length) return pages;

  const ref = raw.match(/\/Dests\s+(\d+) 0 R/);
  if (!ref) return pages;

  const obj = raw.match(new RegExp('(?:^|[^0-9])' + ref[1] + ' 0 obj([\\s\\S]*?)endobj'));
  if (!obj) return pages;

  for (const m of obj[1].matchAll(/\/([^\s/[\]()<>]+)\s*\[\s*(\d+) 0 R/g)) {
    const page = pageOrder.indexOf(Number(m[2])) + 1;
    if (page > 0) pages[decodePdfName(m[1])] = page;
  }
  return pages;
}

// Les emplacements sont émis vides par l'aperçu : seul le PDF connaît les pages.
// `Object.hasOwn` plutôt qu'une simple lecture : la cible vient du document, et
// `constructor` ou `toString` écrirait sinon une propriété héritée dans le HTML.
function fillTocPages(html, pages) {
  return html.replace(
    /<span class="md-toc-page" data-target="([^"]+)"><\/span>/g,
    (whole, target) => (Object.hasOwn(pages, target) && pages[target]
      ? `<span class="md-toc-page" data-target="${target}">${pages[target]}</span>`
      : whole),
  );
}

// Décide s'il faut une seconde passe, et prépare le HTML à rendre. Isolé du
// processus principal pour être exerçable sans navigateur : c'est la règle qui
// évite de doubler le coût d'un export sur un document sans sommaire.
function tocSecondPass(html, pdfBuffer) {
  if (!html.includes('class="md-toc-page"')) return { needed: false, html };
  const numbered = fillTocPages(html, destinationPages(pdfBuffer));
  return numbered === html ? { needed: false, html } : { needed: true, html: numbered };
}

module.exports = { pdfOptions, destinationPages, fillTocPages, decodePdfName, tocSecondPass };
