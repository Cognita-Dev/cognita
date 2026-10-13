// studio/editor/menu.js
// A small popup menu used instead of native <select> dropdowns for "pick an action" controls (Add track, Add effect, track options...).
// Why: on iPhone and iPad a native <select> opens a scrolling wheel that fires "change" while you are still scrolling. The old code reset the
// select inside that handler, which snapped the wheel back and made it feel like nothing could be chosen. This menu is plain buttons, so a tap,
// a click, a pen and the keyboard all behave the same everywhere.
//
// openMenu(anchor, items, onPick, { title, align })
//   items: [{ value, label, icon?, hint?, on?, danger?, disabled? }, { sep: true }]
//   onPick(value, item) runs after the menu has closed.

let cur = null;

export const isMenuOpen = () => !!cur;

export function closeMenu(refocus = false) {
  if (!cur) return;
  const c = cur; cur = null;
  document.removeEventListener('pointerdown', c.onDown, true);
  document.removeEventListener('keydown', c.onKey, true);
  window.removeEventListener('resize', c.onAway); window.removeEventListener('orientationchange', c.onAway);
  window.removeEventListener('scroll', c.onScroll, true);
  c.el.remove();
  if (c.anchor) { c.anchor.setAttribute('aria-expanded', 'false'); if (refocus && c.anchor.isConnected) { try { c.anchor.focus({ preventScroll: true }); } catch (_) { /* ignore */ } } }
}

const esc = (s) => String(s).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));

export function openMenu(anchor, items, onPick, { title = '', align = 'left' } = {}) {
  // tapping the same button again closes the menu (a toggle)
  if (cur && cur.anchor === anchor) { closeMenu(); return; }
  closeMenu();
  const el = document.createElement('div');
  el.className = 'st-menu'; el.setAttribute('role', 'menu'); if (title) el.setAttribute('aria-label', title);
  el.innerHTML = (title ? `<div class="st-menu-title" aria-hidden="true">${esc(title)}</div>` : '') + items.map((it, i) => it.sep
    ? '<div class="st-menu-sep" role="separator"></div>'
    : `<button type="button" role="menuitem" class="st-menu-item${it.on ? ' is-on' : ''}${it.danger ? ' is-danger' : ''}" data-i="${i}"${it.disabled ? ' disabled' : ''}>${it.icon ? `<i class="ph ${esc(it.icon)}" aria-hidden="true"></i>` : '<i class="st-menu-gap" aria-hidden="true"></i>'}<span class="st-menu-l">${esc(it.label)}</span>${it.hint ? `<span class="st-menu-h">${esc(it.hint)}</span>` : ''}${it.on ? '<i class="ph ph-check st-menu-ck" aria-hidden="true"></i>' : ''}</button>`).join('');
  document.body.appendChild(el);

  const place = () => {
    const a = anchor.getBoundingClientRect(); const vw = window.innerWidth, vh = window.innerHeight; const m = 8;
    el.style.maxHeight = Math.max(160, vh - 2 * m) + 'px';
    const mw = el.offsetWidth, mh = el.offsetHeight;
    let left = align === 'right' ? a.right - mw : a.left; left = Math.max(m, Math.min(left, vw - mw - m));
    const below = vh - a.bottom - m, above = a.top - m;
    let top; if (mh <= below || below >= above) { top = a.bottom + 4; el.style.maxHeight = Math.max(120, Math.min(vh - 2 * m, below - 4)) + 'px'; } else { const h = Math.min(mh, above - 4); top = a.top - 4 - h; el.style.maxHeight = Math.max(120, above - 4) + 'px'; }
    el.style.left = left + 'px'; el.style.top = Math.max(m, top) + 'px';
  };
  place();

  const pick = (btn) => {
    const it = items[Number(btn.dataset.i)]; if (!it || it.disabled) return;
    closeMenu(false);
    try { onPick(it.value, it); } catch (err) { console.error('[studio] menu action failed', err); }
  };
  // a plain click handler is the most reliable thing on touch screens
  el.addEventListener('click', (e) => { const b = e.target.closest('.st-menu-item'); if (b) { e.preventDefault(); pick(b); } });
  const onDown = (e) => { if (el.contains(e.target) || (anchor && anchor.contains(e.target))) return; closeMenu(false); };
  const onKey = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeMenu(true); return; }
    if (e.key === 'Tab') { closeMenu(false); return; }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return;
    const bs = [...el.querySelectorAll('.st-menu-item:not([disabled])')]; if (!bs.length) return; e.preventDefault();
    const i = bs.indexOf(document.activeElement); let j = e.key === 'Home' ? 0 : e.key === 'End' ? bs.length - 1 : e.key === 'ArrowDown' ? (i + 1) % bs.length : (i <= 0 ? bs.length - 1 : i - 1); bs[j].focus();
  };
  const onAway = () => closeMenu(false);
  // scrolling the page behind the menu closes it, but scrolling inside the menu itself must not
  const onScroll = (e) => { if (!el.contains(e.target)) closeMenu(false); };
  document.addEventListener('pointerdown', onDown, true); document.addEventListener('keydown', onKey, true);
  window.addEventListener('resize', onAway); window.addEventListener('orientationchange', onAway); window.addEventListener('scroll', onScroll, true);
  cur = { el, anchor, onDown, onKey, onAway, onScroll };
  if (anchor) anchor.setAttribute('aria-expanded', 'true');
  // keyboard users land on the first item (or the checked one); touch users are not shown a focus ring
  const first = el.querySelector('.st-menu-item.is-on:not([disabled])') || el.querySelector('.st-menu-item:not([disabled])');
  if (first && window.matchMedia && !window.matchMedia('(pointer: coarse)').matches) { try { first.focus({ preventScroll: true }); } catch (_) { /* ignore */ } }
  return el;
}
