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
  marked.use({ gfm: true, breaks: false });

  return (source) => marked.parse(preprocess(source));
}
