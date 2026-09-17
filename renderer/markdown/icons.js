const svg = (body) =>
  `<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" class="markdown-alert-icon">${body}</svg>`;

const bang = '<rect x="7.25" y="4.5" width="1.5" height="5" rx="0.75" fill="currentColor"/>'
  + '<circle cx="8" cy="11.5" r="1" fill="currentColor"/>';

export const ICONS = {
  // cercle + i
  note: svg('<circle cx="8" cy="8" r="7" fill="none" stroke="currentColor" stroke-width="1.5"/>'
    + '<circle cx="8" cy="4.5" r="1" fill="currentColor"/>'
    + '<rect x="7.25" y="6.5" width="1.5" height="5" rx="0.75" fill="currentColor"/>'),
  // ampoule
  tip: svg('<circle cx="8" cy="6.5" r="4.5" fill="none" stroke="currentColor" stroke-width="1.5"/>'
    + '<rect x="6" y="11" width="4" height="1.5" rx="0.75" fill="currentColor"/>'
    + '<rect x="6.5" y="13.5" width="3" height="1.5" rx="0.75" fill="currentColor"/>'),
  // bulle de dialogue
  important: svg('<rect x="1" y="2" width="14" height="10" rx="2" fill="none" stroke="currentColor" stroke-width="1.5"/>'
    + '<path d="M5 12 L5 15 L8 12 Z" fill="currentColor"/>'),
  // triangle + !
  warning: svg('<path d="M8 1.5 L15 14 L1 14 Z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/>'
    + '<rect x="7.25" y="6" width="1.5" height="4" rx="0.75" fill="currentColor"/>'
    + '<circle cx="8" cy="12" r="0.9" fill="currentColor"/>'),
  // octogone + !
  caution: svg('<path d="M5.2 1 H10.8 L15 5.2 V10.8 L10.8 15 H5.2 L1 10.8 V5.2 Z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/>'
    + bang),
};
