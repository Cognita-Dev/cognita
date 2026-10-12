// studio/editor/util.js
export const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const fmtSize = (b) => (b > 1073741824 ? (b / 1073741824).toFixed(2) + ' GB' : b > 1048576 ? (b / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(b / 1024)) + ' KB');
export const fmtDur = (s) => { s = Math.max(0, s); const m = Math.floor(s / 60); return m + ':' + String(Math.floor(s % 60)).padStart(2, '0'); };
export const rel = (ts) => { const d = Date.now() - ts; if (d < 6e4) return 'Just now'; if (d < 36e5) return Math.round(d / 6e4) + ' min ago'; if (d < 864e5) return Math.round(d / 36e5) + ' h ago'; return new Date(ts).toLocaleDateString(); };
export function download(blob, name) { const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 4000); }
export const safeName = (s) => (String(s || 'video').replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-').toLowerCase() || 'video');
export const debounce = (fn, ms) => { let t = 0; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
