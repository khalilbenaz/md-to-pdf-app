// Le moteur de rendu markdown : tout ce qui transforme du texte source en HTML
// vit ici. Module ES sans DOM ni `window`, pour que `node --test` puisse
// l'exercer directement au lieu de démarrer Electron.
//
// highlight.js ne publie qu'un build CommonJS et un shim ESM qui le
// ré-exporte : un `<script type="module">` de navigateur récupère le shim puis
// explose sur `require`. C'est ce qui avait fait tomber l'enregistrement de
// KaTeX en v1.1.3. Le bundler règle le problème à la source.
//
// `common` couvre ~35 langages au lieu des 190 (1,0 Mo -> ~230 Ko) ; les
// suppléments ci-dessous sont ceux que cet éditeur croise vraiment.
import { Marked } from 'marked';
import { markedHighlight } from 'marked-highlight';
import markedKatex from 'marked-katex-extension';
import markedFootnote from 'marked-footnote';
import markedAlert from 'marked-alert';
import { createDirectives } from 'marked-directive';
import { LABELS } from './labels.js';
import { ICONS } from './icons.js';
import hljs from 'highlight.js/lib/common';

import dockerfile from 'highlight.js/lib/languages/dockerfile';
import powershell from 'highlight.js/lib/languages/powershell';
import dart from 'highlight.js/lib/languages/dart';
import nginx from 'highlight.js/lib/languages/nginx';
import apache from 'highlight.js/lib/languages/apache';
import scala from 'highlight.js/lib/languages/scala';
import elixir from 'highlight.js/lib/languages/elixir';
import haskell from 'highlight.js/lib/languages/haskell';
import fsharp from 'highlight.js/lib/languages/fsharp';
import lisp from 'highlight.js/lib/languages/lisp';

for (const [name, lang] of Object.entries({
  dockerfile, powershell, dart, nginx, apache, scala, elixir, haskell, fsharp, lisp,
})) hljs.registerLanguage(name, lang);

// `<!-- pagebreak -->` est invisible à l'écran mais doit survivre comme élément
// pour que la feuille d'export puisse y accrocher un `break-after`.
function preprocess(source) {
  return source.replace(/<!--\s*pagebreak\s*-->/gi, '<div class="page-break"></div>');
}

const ALERT_TYPES = Object.keys(LABELS.alerts);

// `> [!NOTE]` est la syntaxe principale : native sur GitHub et Obsidian, et
// elle dégrade en simple citation partout ailleurs. `:::note` est accepté en
// second pour les documents venus d'un Docusaurus, et rend le même HTML.
const directiveAlerts = {
  level: 'container',
  marker: ':::',
  renderer(token) {
    const name = token.meta.name;
    // Retourner `false` ne rend pas la main à un renderer de repli : marked 14
    // concatène `ret || ''` et le bloc entier disparaît. Un `:::danger` venu
    // d'un Docusaurus perdrait tout son contenu. On rend donc le corps analysé,
    // sans encadré : la syntaxe inconnue dégrade au lieu de détruire.
    if (!ALERT_TYPES.includes(name)) return this.parser.parse(token.tokens);
    return `<div class="markdown-alert markdown-alert-${name}">`
      + `<p class="markdown-alert-title">${ICONS[name]}${LABELS.alerts[name]}</p>`
      + this.parser.parse(token.tokens)
      + '</div>';
  },
};

export function createParser() {
  const marked = new Marked();

  marked.use(markedHighlight({
    langPrefix: 'hljs language-',
    highlight(code, lang) {
      const language = hljs.getLanguage(lang) ? lang : 'plaintext';
      return hljs.highlight(code, { language, ignoreIllegals: true }).value;
    },
  }));

  marked.use(markedKatex({ throwOnError: false }));

  // `headingClass: ''` retire la classe `sr-only` par défaut : le titre doit
  // être visible, c'est un document imprimé, pas une page web.
  marked.use(markedFootnote({
    description: LABELS.footnotes,
    headingClass: '',
    footnoteDivider: true,
    backRefLabel: LABELS.backref,
  }));

  marked.use(markedAlert({
    variants: ALERT_TYPES.map(type => ({
      type,
      icon: ICONS[type],
      title: LABELS.alerts[type],
    })),
  }));

  marked.use(createDirectives([directiveAlerts]));

  marked.use({ gfm: true, breaks: false });

  return (source) => marked.parse(preprocess(source));
}
