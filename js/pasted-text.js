// Long pasted text becomes an attached text file instead of flooding the message box
// (the same way other chat agents do it). The person can still type a prompt next to it,
// send it alone, open it to edit, or remove it. Nothing here touches the network.

export const PASTE_MIN_CHARS = 3000;   // about a page of prose
export const PASTE_MIN_LINES = 40;     // long lists, logs and code

export function shouldConvertPaste(text) {
  const t = String(text || '');
  if (!t.trim()) return false;
  if (t.length >= PASTE_MIN_CHARS) return true;
  return t.length >= 600 && t.split(/\r?\n/).length >= PASTE_MIN_LINES;
}

// "Pasted text.txt", then "Pasted text 2.txt" ... so two pastes never clash.
export function pastedFileName(existingNames) {
  const taken = new Set((existingNames || []).map((n) => String(n).toLowerCase()));
  let name = 'Pasted text.txt';
  for (let n = 2; taken.has(name.toLowerCase()); n++) name = 'Pasted text ' + n + '.txt';
  return name;
}

export function makePastedFile(text, name) {
  return new File([String(text)], name || 'Pasted text.txt', { type: 'text/plain' });
}

export function describeSize(text) {
  const n = String(text || '').length;
  const words = (String(text || '').match(/\S+/g) || []).length;
  return (n >= 1000 ? (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k' : String(n)) + ' characters, ' + words.toLocaleString() + ' words';
}

// Full-screen editor sheet. onSave(newText) runs when the person taps Save.
export function openTextEditor({ name, text, onSave }) {
  const prev = document.activeElement;
  const wrap = document.createElement('div');
  wrap.className = 'paste-editor';
  wrap.setAttribute('role', 'dialog');
  wrap.setAttribute('aria-modal', 'true');
  wrap.setAttribute('aria-label', 'Edit ' + name);
  wrap.innerHTML =
    '<div class="paste-editor-card">' +
      '<div class="paste-editor-head"><div><div class="paste-editor-title"></div><div class="paste-editor-meta"></div></div>' +
      '<button type="button" class="paste-editor-x" aria-label="Close"><i class="ph ph-x"></i></button></div>' +
      '<textarea class="paste-editor-text" spellcheck="false"></textarea>' +
      '<div class="paste-editor-actions"><button type="button" class="paste-editor-cancel">Cancel</button>' +
      '<button type="button" class="paste-editor-save">Save</button></div>' +
    '</div>';
  const $ = (s) => wrap.querySelector(s);
  const ta = $('.paste-editor-text');
  $('.paste-editor-title').textContent = name;
  ta.value = String(text || '');
  const meta = () => { $('.paste-editor-meta').textContent = describeSize(ta.value); };
  meta();
  ta.addEventListener('input', meta);
  const close = () => { document.removeEventListener('keydown', onKey, true); wrap.remove(); if (prev && prev.focus) { try { prev.focus(); } catch (e) {} } };
  const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
  document.addEventListener('keydown', onKey, true);
  $('.paste-editor-x').addEventListener('click', close);
  $('.paste-editor-cancel').addEventListener('click', close);
  $('.paste-editor-save').addEventListener('click', async () => { const v = ta.value; close(); await onSave(v); });
  wrap.addEventListener('click', (e) => { if (e.target === wrap) close(); });
  document.body.appendChild(wrap);
  ta.focus();
  return close;
}
