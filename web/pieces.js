/*
 * Chess piece sets.
 *
 * Two kinds:
 *   'files'  — one image per piece under web/piecesets/<id>/, e.g. wK.svg.
 *              These carry their own colours, so themes do not restyle them.
 *              Every Lichess set is shipped this way.
 *   'inline' — geometry defined here and coloured from CSS custom properties.
 *              Only the built-in "Classic" set uses it; it exists so the picker
 *              is never empty if the piecesets folder is missing.
 *
 * The list is built from whatever is on disk, so installing a set is a matter
 * of dropping its folder into web/piecesets/ — no code change. The table below
 * only supplies nicer names and the artist credit.
 *
 * Licences are recorded in assets/NOTICE.md.
 */

'use strict';

/* Display names and credits for the Lichess sets. Anything not listed here
 * still appears — it just gets its folder name title-cased. */
const PIECE_SET_META = {
  alpha:                { label: 'Alpha', note: 'Eric Bentzen' },
  anarcandy:            { label: 'Anarcandy', note: 'caderek' },
  caliente:             { label: 'Caliente', note: 'avi' },
  california:           { label: 'California', note: 'Jerry S.' },
  cardinal:             { label: 'Cardinal', note: 'sadsnake1' },
  cburnett:             { label: 'Cburnett', note: 'Lichess default' },
  celtic:               { label: 'Celtic', note: 'Maurizio Monge' },
  chess7:               { label: 'Chess7', note: 'Style-7' },
  chessnut:             { label: 'Chessnut', note: 'Alexis Luengas' },
  companion:            { label: 'Companion', note: 'David L. Brown' },
  cooke:                { label: 'Cooke', note: 'fejfar' },
  disguised:            { label: 'Disguised', note: 'danegraphics — every piece alike' },
  dubrovny:             { label: 'Dubrovny', note: 'sadsnake1' },
  fantasy:              { label: 'Fantasy', note: 'Maurizio Monge' },
  firi:                 { label: 'Firi', note: 'James Faure' },
  fresca:               { label: 'Fresca', note: 'sadsnake1' },
  gioco:                { label: 'Gioco', note: 'sadsnake1' },
  governor:             { label: 'Governor', note: 'unattributed' },
  horsey:               { label: 'Horsey', note: 'cham, michael1241' },
  icpieces:             { label: 'IC Pieces', note: 'sadsnake1' },
  'kiwen-suwi':         { label: 'Kiwen-suwi', note: 'neverRare' },
  kosal:                { label: 'Kosal', note: 'unattributed' },
  leipzig:              { label: 'Leipzig', note: 'Armando Hernandez Marroquin' },
  letter:               { label: 'Letter', note: 'usolando — letters, not figures' },
  maestro:              { label: 'Maestro', note: 'sadsnake1' },
  merida:               { label: 'Merida', note: 'Armando Hernandez Marroquin' },
  monarchy:             { label: 'Monarchy', note: 'slither77 — raster art' },
  mpchess:              { label: 'MPChess', note: 'Maxime Chupin' },
  papercut:             { label: 'Papercut', note: 'Nikolay Anzarov' },
  pirouetti:            { label: 'Pirouetti', note: 'pirouetti' },
  pixel:                { label: 'Pixel', note: 'therealqtpi' },
  reillycraig:          { label: 'Reilly Craig', note: 'Reilly Craig' },
  rhosgfx:              { label: 'RhosGFX', note: 'RhosGFX' },
  riohacha:             { label: 'Riohacha', note: 'unattributed' },
  'shahi-ivory-brown':  { label: 'Shahi Ivory Brown', note: 'Tamer Karatekin' },
  shapes:               { label: 'Shapes', note: 'flugsio' },
  spatial:              { label: 'Spatial', note: 'Maurizio Monge' },
  staunty:              { label: 'Staunty', note: 'sadsnake1' },
  tatiana:              { label: 'Tatiana', note: 'sadsnake1' },
  totoy:                { label: 'Totoy', note: 'Kosal Sen' },
  xkcd:                 { label: 'xkcd', note: 'Randall Munroe' },
};

/* Shown first in the picker: the two sets most people actually want. */
const PREFERRED_ORDER = ['cburnett', 'merida'];

const CLASSIC_SET = {
  id: 'classic', label: 'Classic', note: 'built-in, outlined', kind: 'inline',
};

let PIECE_SETS = [CLASSIC_SET];
let PIECE_SET_IDS = PIECE_SETS.map((s) => s.id);

/**
 * Rebuild the set list from what the backend found on disk.
 * `entries` is [{ id, ext }]; the built-in Classic set is always kept last so
 * there is something to fall back on.
 */
function registerDiscoveredSets(entries) {
  const found = (entries || []).map((e) => (typeof e === 'string' ? { id: e, ext: 'svg' } : e));

  found.sort((a, b) => {
    const ra = PREFERRED_ORDER.indexOf(a.id);
    const rb = PREFERRED_ORDER.indexOf(b.id);
    if (ra !== rb) return (ra < 0 ? 99 : ra) - (rb < 0 ? 99 : rb);
    return a.id.localeCompare(b.id);
  });

  PIECE_SETS = found.map((e) => {
    const meta = PIECE_SET_META[e.id] || {};
    return {
      id: e.id,
      ext: e.ext || 'svg',
      kind: 'files',
      label: meta.label || e.id.charAt(0).toUpperCase() + e.id.slice(1),
      note: meta.note || 'installed',
    };
  });
  PIECE_SETS.push(CLASSIC_SET);
  PIECE_SET_IDS = PIECE_SETS.map((s) => s.id);
}

/* Geometry for the 'inline' sets. Drawn to fill x 7..38, y 3..41 of a 45x45
 * viewBox — roughly what a real piece occupies on a square. */
const PIECE_SHAPES = {
  p: `<path d="M22.5 6.4c-3.15 0-5.7 2.55-5.7 5.7 0 1.2.37 2.32 1 3.24
        -2.1 1.18-3.52 3.42-3.52 6 0 2.03.88 3.86 2.29 5.12
        -3.77 2.77-6.32 7.74-6.83 13.54h25.52c-.51-5.8-3.06-10.77-6.83-13.54
        1.41-1.26 2.29-3.09 2.29-5.12 0-2.58-1.42-4.82-3.52-6 .63-.92 1-2.04 1-3.24
        0-3.15-2.55-5.7-5.7-5.7z"/>
      <rect x="8.4" y="35.6" width="28.2" height="5" rx="2"/>`,

  r: `<path d="M9.6 10.2h6v4.3h4.7v-4.3h4.4v4.3h4.7v-4.3h6v9.3l-2.8 2.5v10.6l2.8 2.5H9.6
        l2.8-2.5V22l-2.8-2.5z"/>
      <rect x="8.2" y="35.2" width="28.6" height="5.4" rx="2"/>`,

  n: `<path d="M25.4 4.6c-.75 2.85-3.05 4.55-5.75 6-4.6 2.6-9 6.3-10.4 11.75
        -.7 2.6-.4 4.9.85 6 1.25 1.1 2.95.55 4.1-.6l3.25-3.25c.95-.95 2.4-.3 2.3 1.05
        -.4 4.4-2.5 8.25-5.35 11.3h23.1c1.9-6.5 2.4-13.8.85-20.05
        -1.55-6.2-5.75-10.5-10.95-12.2z"/>
      <path class="detail" d="M19.4 10.9c-1.15 2-3.35 3.45-5.45 5"
        fill="none" stroke-width="1.3"/>
      <circle class="eye" cx="15.6" cy="21.2" r="1.5"/>
      <rect x="9.6" y="35.4" width="25.8" height="2.6" rx="1.2"/>
      <rect x="8.2" y="37.8" width="28.6" height="2.8" rx="1.3"/>`,

  b: `<circle cx="22.5" cy="6.6" r="2.7"/>
      <path d="M22.5 9.3c6.05 5.1 9.75 11.3 9.75 16.1 0 4.4-4.3 7.7-9.75 7.7
        s-9.75-3.3-9.75-7.7c0-4.8 3.7-11 9.75-16.1z"/>
      <path class="detail" d="M18.6 22.3h7.8" fill="none" stroke-width="1.7"/>
      <rect x="13" y="32.6" width="19" height="3.4" rx="1.5"/>
      <rect x="8.2" y="35.8" width="28.6" height="4.8" rx="2"/>`,

  q: `<circle cx="22.5" cy="5.2" r="2.7"/>
      <circle cx="8.7" cy="11.2" r="2.5"/>
      <circle cx="36.3" cy="11.2" r="2.5"/>
      <circle cx="14.9" cy="7.4" r="2.2"/>
      <circle cx="30.1" cy="7.4" r="2.2"/>
      <path d="M8.7 12.6l4.3 17.6h19l4.3-17.6-6.7 6-3.6-9.9-3.7 10.4-3.7-10.4-3.6 9.9z"/>
      <rect x="11.2" y="30.4" width="22.6" height="3.6" rx="1.4"/>
      <rect x="8.2" y="34.2" width="28.6" height="3.4" rx="1.4"/>
      <rect x="9.4" y="37.8" width="26.2" height="2.8" rx="1.3"/>`,

  k: `<path class="detail" d="M22.5 3.2v8.6M18.2 7.1h8.6" fill="none"
        stroke-width="2.6" stroke-linecap="round"/>
      <path d="M22.5 12.2c-7.2 0-12.5 4.8-12.5 10.7 0 4.1 2.2 7.4 4.7 9.6h15.6
        c2.5-2.2 4.7-5.5 4.7-9.6 0-5.9-5.3-10.7-12.5-10.7z"/>
      <rect x="11.2" y="32.4" width="22.6" height="3.6" rx="1.4"/>
      <rect x="8.2" y="36.2" width="28.6" height="4.4" rx="1.8"/>`,
};

function setById(id) {
  return PIECE_SETS.find((s) => s.id === id) || PIECE_SETS[0];
}

/** File name Lichess-style sets use: colour letter + upper-case piece letter. */
function pieceCode(letter) {
  return (letter === letter.toUpperCase() ? 'w' : 'b') + letter.toUpperCase();
}

/** Markup for one piece in a given set. `letter` is a FEN char. */
function pieceHTML(letter, setId) {
  const set = setById(setId);
  if (set.kind === 'files') {
    const file = `${pieceCode(letter)}.${set.ext || 'svg'}`;
    return `<img class="pc" src="/piecesets/${set.id}/${file}"`
         + ` alt="" draggable="false">`;
  }
  const shapes = PIECE_SHAPES[letter.toLowerCase()];
  if (!shapes) return '';
  const colour = letter === letter.toUpperCase() ? 'white' : 'black';
  return `<svg class="pc ${colour}" viewBox="0 0 45 45" aria-hidden="true">${shapes}</svg>`;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    PIECE_SHAPES, PIECE_SETS, PIECE_SET_IDS, pieceHTML, pieceCode,
    registerDiscoveredSets,
  };
}
