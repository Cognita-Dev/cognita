// studio/editor/dialog.js
// One modal dialog for the whole studio. Escape closes it, Tab stays inside it, focus returns to whatever opened it.
let opener = null, onCloseCb = null, wired = false;
const layer = () => document.getElementById('stModal');
export const dialogOpen = () => { const m = layer(); return !!m && !m.hidden; };
export function openDialog(html, { onClose, locked } = {}) {
  const m = layer(); if (!m) return null; if (m.hidden) opener = document.activeElement; onCloseCb = onClose || null; m.hidden = false; m.dataset.locked = locked ? '1' : '';
  m.innerHTML = `<div class="st-dialog" role="dialog" aria-modal="true" aria-labelledby="stDlgT">${html}</div>`;
  if (!wired) { wired = true; document.addEventListener('keydown', onKey, true); }
  const f = m.querySelector('[data-autofocus]') || m.querySelector('button, select, input, a'); if (f) f.focus();
  return m.firstElementChild;
}
export function closeDialog() {
  const m = layer(); if (!m || m.hidden) return; m.hidden = true; m.innerHTML = ''; const cb = onCloseCb; onCloseCb = null; if (cb) cb();
  if (opener && document.contains(opener)) { try { opener.focus(); } catch (_) { /* ignore */ } } opener = null;
}
function onKey(e) {
  const m = layer(); if (!m || m.hidden) return;
  if (e.key === 'Escape') { if (m.dataset.locked) return; e.preventDefault(); e.stopPropagation(); closeDialog(); return; }
  if (e.key === 'Tab') {
    const f = [...m.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')].filter((x) => !x.disabled && x.offsetParent !== null);
    if (!f.length) { e.preventDefault(); return; } const a = f[0], z = f[f.length - 1];
    if (!m.contains(document.activeElement)) { e.preventDefault(); a.focus(); } else if (e.shiftKey && document.activeElement === a) { e.preventDefault(); z.focus(); } else if (!e.shiftKey && document.activeElement === z) { e.preventDefault(); a.focus(); }
  }
}
