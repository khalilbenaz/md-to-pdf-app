// Entrée navigateur du moteur : bundlée par esbuild, elle se contente de lier
// le module au global. Toute la logique vit dans ./markdown/, faute de quoi les
// tests unitaires auraient besoin d'un `window` factice.
import { createParser } from './markdown/parse.js';
import { enhance } from './markdown/enhance.js';

window.md = { parse: createParser(), enhance };
