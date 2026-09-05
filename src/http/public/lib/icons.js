/**
 * The icon set.
 *
 * One place, so every icon in the product is the same weight, the same corner
 * radius and the same 24-unit grid — which is the difference between a set of
 * icons and a pile of glyphs. These are line icons (stroke, not fill) in the
 * Feather idiom: 2px stroke, round caps and joins, `currentColor` so an icon
 * takes the colour of the text beside it and turns white on a filled chip
 * without a second rule.
 *
 * They replaced the emoji this UI used to reach for (📍 🔎 📅 🔔 🔒 …). Emoji
 * render as a different typeface on every OS, carry their own colour, and are
 * the single loudest "assembled quickly" tell in a product — a booking app
 * wants an icon that looks drawn for it, not a picture borrowed from a phone
 * keyboard.
 *
 *   iconSvg('pin')            -> markup string, for innerHTML / template literals
 *   iconEl('pin', { size })   -> a live <svg> element, for el().append(...)
 */

// viewBox is 24×24. Paths are authored to sit on that grid so the stroke width
// reads identically across the set.
const PATHS = {
  // location — the map pin, used for "select location", the salon address and
  // the "pin my location" affordances.
  pin: '<path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0z"/><circle cx="12" cy="10" r="3"/>',
  // search
  search: '<circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>',
  // directions / navigate to
  navigation: '<polygon points="3 11 22 2 13 21 11 13 3 11"/>',
  // my bookings
  calendar: '<rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/>',
  // notifications
  bell: '<path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/>',
  // appearance — light
  sun: '<circle cx="12" cy="12" r="4"/><line x1="12" y1="2" x2="12" y2="4"/><line x1="12" y1="20" x2="12" y2="22"/><line x1="4.93" y1="4.93" x2="6.34" y2="6.34"/><line x1="17.66" y1="17.66" x2="19.07" y2="19.07"/><line x1="2" y1="12" x2="4" y2="12"/><line x1="20" y1="12" x2="22" y2="12"/><line x1="4.93" y1="19.07" x2="6.34" y2="17.66"/><line x1="17.66" y1="6.34" x2="19.07" y2="4.93"/>',
  // appearance — dark
  moon: '<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>',
  // appearance — follows system (half)
  contrast: '<circle cx="12" cy="12" r="9"/><path d="M12 3v18a9 9 0 0 0 0-18z" fill="currentColor" stroke="none"/>',
  // security note
  lock: '<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
  // confirmed / done
  check: '<polyline points="20 6 9 17 4 12"/>',
  // empty / nothing here yet
  inbox: '<polyline points="22 12 16 12 14 15 10 15 8 12 2 12"/><path d="M5.45 5.11L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>',
  // upcoming / pending
  clock: '<circle cx="12" cy="12" r="9"/><polyline points="12 7 12 12 15 14"/>',
  // past / neutral marker
  circle: '<circle cx="12" cy="12" r="9"/>',
  // catalogue
  tag: '<path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"/><line x1="7" y1="7" x2="7.01" y2="7"/>',
  // saved / favourites
  heart: '<path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.6l-1-1a5.5 5.5 0 0 0-7.8 7.8l1 1L12 21l7.8-7.6 1-1a5.5 5.5 0 0 0 0-7.8z"/>',
  // back
  'chevron-left': '<polyline points="15 18 9 12 15 6"/>',
  // the bottom bar's first and last tabs. Its middle two are `search` and
  // `calendar`, which the set already had.
  home: '<path d="M3 10.5 12 3l9 7.5"/><path d="M5.5 9.4V20a1 1 0 0 0 1 1h11a1 1 0 0 0 1-1V9.4"/>',
  user: '<circle cx="12" cy="8" r="3.6"/><path d="M4.5 20.5a7.5 7.5 0 0 1 15 0"/>',
};

/** Icon names known to the set — lets callers fall back to text for anything else. */
export function hasIcon(name) {
  return Object.prototype.hasOwnProperty.call(PATHS, name);
}

export function iconSvg(name, { size = 20, cls = '' } = {}) {
  const body = PATHS[name] ?? PATHS.check;
  return (
    `<svg class="icon${cls ? ' ' + cls : ''}" viewBox="0 0 24 24" ` +
    `width="${size}" height="${size}" fill="none" stroke="currentColor" ` +
    `stroke-width="2" stroke-linecap="round" stroke-linejoin="round" ` +
    `aria-hidden="true" focusable="false">${body}</svg>`
  );
}

export function iconEl(name, opts = {}) {
  const tpl = document.createElement('template');
  tpl.innerHTML = iconSvg(name, opts);
  return tpl.content.firstElementChild;
}
