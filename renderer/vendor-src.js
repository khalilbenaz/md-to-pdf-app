// highlight.js ships only a CommonJS build plus an ESM shim that re-exports it.
// A browser <script type="module"> can fetch that shim but blows up on `require`,
// so the import used to throw and nothing downstream of it ever ran — including
// the KaTeX registration that shared its callback. Bundling it here gives the
// renderer a plain global, loaded synchronously.
//
// `common` covers ~35 languages instead of the full 190 (1.0 MB -> ~230 KB); the
// extras below are the ones this editor actually runs into that common omits.
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

window.hljs = hljs;
