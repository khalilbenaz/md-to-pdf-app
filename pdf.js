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

// Un nom PDF échappe hors de l'ASCII imprimable en `#XX`, octet par octet. Nos
// slugs gardent leurs accents, donc `périmètre` revient en `p#c3#a9rim#c3#a8tre`.
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
  return Buffer.from(bytes).toString('utf8');
}

// L'ordre de lecture du document est celui du tableau /Kids de l'objet
// /Type /Pages : c'est la définition même du format, rien à déduire. Repli sur
// l'ordre d'apparition textuelle des objets de page si ce tableau est
// introuvable — c'était le seul signal disponible avant cette fonction, il
// reste correct tant que PDFium écrit ses objets dans l'ordre de lecture.
function pageOrderOf(raw) {
  for (const m of raw.matchAll(/(\d+) 0 obj\s*<<([\s\S]*?)>>\s*endobj/g)) {
    if (/\/Type\s*\/Pages\b/.test(m[2])) {
      const kids = m[2].match(/\/Kids\s*\[([^\]]*)\]/);
      if (kids) {
        const order = [...kids[1].matchAll(/(\d+) 0 R/g)].map(k => Number(k[1]));
        if (order.length) return order;
      }
    }
  }
  return [...raw.matchAll(/(\d+) 0 obj\s*<<[^>]*?\/Type\s*\/Page[^s]/g)].map(m => Number(m[1]));
}

// Chromium nomme ses destinations d'après les identifiants d'ancre du document
// et n'emploie pas de flux d'objets : la table est lisible telle quelle. Rendre
// un objet vide plutôt que lever, pour qu'un changement de Chromium coûte des
// numéros de page absents et non un export en échec.
function destinationPages(pdfBuffer) {
  const raw = Buffer.isBuffer(pdfBuffer) ? pdfBuffer.toString('latin1') : String(pdfBuffer);

  const pageOrder = pageOrderOf(raw);
  if (!pageOrder.length) return {};

  const ref = raw.match(/\/Dests\s+(\d+) 0 R/);
  if (!ref) return {};

  const obj = raw.match(new RegExp('(?:^|[^0-9])' + ref[1] + ' 0 obj([\\s\\S]*?)endobj'));
  if (!obj) return {};

  const pages = {};
  for (const m of obj[1].matchAll(/\/([^\s/[\]()<>]+)\s*\[\s*(\d+) 0 R/g)) {
    const page = pageOrder.indexOf(Number(m[2])) + 1;
    if (page > 0) pages[decodePdfName(m[1])] = page;
  }
  return pages;
}

// Les emplacements sont émis vides par l'aperçu : seul le PDF connaît les pages.
function fillTocPages(html, pages) {
  return html.replace(
    /<span class="md-toc-page" data-target="([^"]+)"><\/span>/g,
    (whole, target) => (pages[target]
      ? `<span class="md-toc-page" data-target="${target}">${pages[target]}</span>`
      : whole),
  );
}

module.exports = { pdfOptions, destinationPages, fillTocPages, decodePdfName };
