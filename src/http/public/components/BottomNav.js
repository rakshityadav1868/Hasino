import { el } from '../lib/dom.js';
import { iconEl } from '../lib/icons.js';

/**
 * The four destinations, as line icons from the one icon set.
 *
 * They were filled Material paths pasted in as raw `d` strings, which is why
 * the bar was the one place in the app whose icons were a different weight
 * from every other icon in it. These are the same 24-grid, 2px stroke marks
 * the rest of the product uses, so the bar belongs to the app rather than
 * looking borrowed from another one. The destinations and their labels are
 * unchanged.
 */
const ITEMS = [
  { key: 'home', label: 'Home', hash: '#/home', icon: 'home' },
  { key: 'explore', label: 'Explore', hash: '#/explore', icon: 'search' },
  { key: 'bookings', label: 'Bookings', hash: '#/bookings', icon: 'calendar' },
  { key: 'profile', label: 'Profile', hash: '#/profile', icon: 'user' },
];

export function BottomNav(activeKey) {
  const nav = el('div', 'bottom-nav');
  for (const item of ITEMS) {
    const a = el('a', 'nav-item' + (item.key === activeKey ? ' active' : ''));
    a.href = item.hash;
    a.append(iconEl(item.icon, { size: 23 }), el('span', null, item.label));
    nav.append(a);
  }
  return nav;
}
