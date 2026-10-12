// studio/editor/shortcuts.js
// Keyboard shortcuts and the cheat sheet. Keys never fire while typing in a field, while a dialog is open, or when Space
// would press a focused button.
import { S, P, on, emit, undo, redo, splitAt, deleteClips, duplicateSel, copySel, pasteAt, groupSel, ungroupSel, addMarker, select, clearSel, dur, fps, snapT, toast, save } from './state.js';
import { toggle, play, pause, seek, step } from './preview.js';
import { zoomBy, fit, setToolbarState } from './timeline.js';
import { openDialog, closeDialog, dialogOpen } from './dialog.js';
import { openExport } from './export-ui.js';

export const KEYS = [
  ['Playback', [['Space', 'Play or pause'], ['K', 'Pause'], ['L', 'Play'], ['J', 'Back 1 second'], ['Left / Right', 'Back or forward one frame'], ['Shift + Left / Right', 'Back or forward 1 second'], ['Home / End', 'Go to start or end']]],
  ['Editing', [['S', 'Split at playhead'], ['Delete', 'Delete selected clips'], ['Shift + Delete', 'Delete and close the gap'], ['D', 'Duplicate'], ['Ctrl/Cmd + C, V', 'Copy and paste at playhead'], ['A', 'Select all clips'], ['G / Shift + G', 'Group or ungroup'], ['M', 'Add or remove a marker'], ['I / O', 'Set the In or Out mark'], ['Escape', 'Deselect']]],
  ['Timeline', [['Ctrl/Cmd + Z', 'Undo'], ['Ctrl/Cmd + Shift + Z, or Y', 'Redo'], ['+ / -', 'Zoom in or out'], ['Shift + Z', 'Fit the timeline'], ['N', 'Snapping on or off'], ['R', 'Ripple trim on or off']]],
  ['Project', [['Ctrl/Cmd + S', 'Save now'], ['Ctrl/Cmd + E', 'Export'], ['?', 'Show this list']]],
];
export function showCheatSheet() {
  openDialog(`<h3 id="stDlgT">Keyboard shortcuts</h3><div class="st-keys">${KEYS.map(([g, rows]) => `<section><h4>${g}</h4><dl>${rows.map(([k, d]) => `<dt><kbd>${k.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</kbd></dt><dd>${d}</dd>`).join('')}</dl></section>`).join('')}</div><div class="st-dlg-foot"><button type="button" class="st-btn st-btn--primary" id="keyClose" data-autofocus>Close</button></div>`);
  document.getElementById('keyClose').addEventListener('click', closeDialog);
}
let installed = false, offs = [];
export function installShortcuts(isActive) {
  if (installed) return; installed = true; document.addEventListener('keydown', onKey); offs.push(on('shortcuts', showCheatSheet));
  window.__studioIsActive = isActive;
}
export function removeShortcuts() { installed = false; document.removeEventListener('keydown', onKey); offs.forEach((f) => f()); offs = []; }
function onKey(e) {
  if (!window.__studioIsActive || !window.__studioIsActive() || S.screen !== 'editor' || !P() || dialogOpen()) return;
  const tag = (e.target.tagName || '').toLowerCase(); if (['input', 'textarea', 'select'].includes(tag) || e.target.isContentEditable) return;
  const mod = e.metaKey || e.ctrlKey; const k = e.key; const lk = k.length === 1 ? k.toLowerCase() : k; const ids = () => [...S.sel];
  if (k === ' ' && (['button', 'a', 'summary'].includes(tag))) return; if (e.altKey) return;
  const done = () => e.preventDefault();
  if (mod) {
    if (lk === 'z') { done(); e.shiftKey ? redo() : undo(); } else if (lk === 'y') { done(); redo(); } else if (lk === 'c') { if (copySel()) done(); } else if (lk === 'x') { if (copySel()) { done(); deleteClips(ids(), false); } } else if (lk === 'v') { if (S.clipboard) { done(); pasteAt(S.t, 0); } }
    else if (lk === 's') { done(); save().then(() => toast('Saved.')); } else if (lk === 'e') { done(); openExport(); } else if (lk === 'a') { done(); select(P().clips.map((c) => c.id)); }
    return;
  }
  if (k === ' ') { done(); toggle(); } else if (lk === 'k') { done(); pause(); } else if (lk === 'l') { done(); play(); } else if (lk === 'j') { done(); pause(); seek(S.t - 1); }
  else if (k === 'ArrowLeft') { done(); e.shiftKey ? seek(S.t - 1) : step(-1); } else if (k === 'ArrowRight') { done(); e.shiftKey ? seek(S.t + 1) : step(1); }
  else if (k === 'Home') { done(); seek(0); } else if (k === 'End') { done(); seek(Math.max(0, dur() - 1 / fps())); }
  else if (lk === 's') { done(); splitAt(snapT(S.t), ids().length ? ids() : null); } else if (k === 'Delete' || k === 'Backspace') { if (S.sel.size) { done(); deleteClips(ids(), e.shiftKey); } }
  else if (lk === 'd') { done(); duplicateSel(); } else if (lk === 'a') { done(); select(P().clips.map((c) => c.id)); } else if (lk === 'g') { done(); e.shiftKey ? ungroupSel() : groupSel(); }
  else if (lk === 'm') { done(); addMarker(snapT(S.t)); } else if (lk === 'i') { done(); S.markIn = snapT(S.t); if (S.markOut != null && S.markOut <= S.markIn) S.markOut = null; toast('In mark set.'); on_ping(); } else if (lk === 'o') { done(); S.markOut = snapT(S.t); if (S.markIn != null && S.markIn >= S.markOut) S.markIn = null; toast('Out mark set.'); on_ping(); }
  else if (k === '+' || k === '=') { done(); zoomBy(1.25); } else if (k === '-' || k === '_') { done(); zoomBy(0.8); } else if (k === 'Z' && e.shiftKey) { done(); fit(); }
  else if (lk === 'n') { done(); S.snap = !S.snap; setToolbarState(); } else if (lk === 'r') { done(); S.ripple = !S.ripple; setToolbarState(); } else if (k === '?') { done(); showCheatSheet(); } else if (k === 'Escape') { clearSel(); }
}
function on_ping() { emit('time'); }
