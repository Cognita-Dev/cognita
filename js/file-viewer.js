// js/file-viewer.js
//
// The preview sheet for files the assistant made (web pages, PDF, Excel, Word,
// PowerPoint outline, CSV, text, pictures). It opens over the chat on a phone
// and as a side panel on a wide screen, so the conversation never reflows.
//
// Nothing here runs a file's own code in the Cognita page:
//   - web pages run in /preview-frame (no network, opaque origin, see vercel.json)
//   - documents are drawn by /file-preview (same isolation, library per file type)
//   - pictures are shown through <img src="blob:..."> and never as markup
// The Cognita page only ever holds the file's bytes and sends them over postMessage.

import { escapeHtml, showToast } from './shell.js';

const EXT_KIND = {
  html: 'html', htm: 'html',
  png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', webp: 'image', svg: 'image',
  pdf: 'pdf',
  xlsx: 'sheet', xlsm: 'sheet', xls: 'sheet',
  csv: 'csv', tsv: 'csv',
  docx: 'word',
  pptx: 'slides',
  txt: 'text', md: 'text', json: 'text', log: 'text', xml: 'text', yaml: 'text', yml: 'text',
  py: 'text', js: 'text', css: 'text',
};

const KIND_LABEL = {
  html: 'Interactive page', image: 'Picture', pdf: 'PDF document', sheet: 'Spreadsheet', csv: 'Table',
  word: 'Word document', slides: 'Presentation', text: 'Text file',
};

const KIND_ICON = {
  html: 'ph-browser', image: 'ph-image', pdf: 'ph-file-pdf', sheet: 'ph-file-xls', csv: 'ph-file-csv',
  word: 'ph-file-doc', slides: 'ph-file-ppt', text: 'ph-file-text',
};

const MAX_BYTES = 15 * 1024 * 1024;
const MAX_HTML_CHARS = 250000; // the limit /preview-frame accepts

export function previewKind(name) {
  const m = /\.([a-z0-9]{1,5})$/i.exec(String(name || ''));
  return m ? (EXT_KIND[m[1].toLowerCase()] || null) : null;
}
export const canPreview = (name) => !!previewKind(name);
export const fileIconClass = (name) => KIND_ICON[previewKind(name)] || 'ph-file-arrow-down';
export const previewLabel = (name) => KIND_LABEL[previewKind(name)] || 'File';
export const isHtmlFile = (name) => previewKind(name) === 'html';

function formatSize(n) {
  if (!Number.isFinite(n)) return '';
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return Math.round(n / 1024) + ' KB';
  return (n / 1024 / 1024).toFixed(1) + ' MB';
}

function themeColours() {
  const cs = getComputedStyle(document.documentElement);
  const pick = (v) => cs.getPropertyValue(v).trim();
  return { bg: pick('--bg-elevated'), fg: pick('--text-1'), muted: pick('--text-2'), line: pick('--border-strong'), soft: pick('--bg-subtle'), accent: pick('--accent') };
}

let current = null;

export function isFilePreviewOpen() { return !!current; }

export function closeFilePreview(immediate) {
  if (!current) return;
  const c = current;
  current = null;
  document.removeEventListener('keydown', c.onKey, true);
  window.removeEventListener('message', c.onMsg);
  window.removeEventListener('message', c.onFrameKey);
  if (c.objectUrl) URL.revokeObjectURL(c.objectUrl);
  document.documentElement.style.overflow = c.prevOverflow;
  c.root.classList.add('is-closing');
  const done = () => { c.root.remove(); if (c.prevFocus && c.prevFocus.focus) { try { c.prevFocus.focus(); } catch (_) { /* gone */ } } };
  if (immediate || (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches)) done();
  else setTimeout(done, 160);
}

/**
 * opts: {
 *   name       file name (decides how it is shown)
 *   title      label to show instead of the name (optional)
 *   size       bytes, for the subtitle (optional)
 *   getBlob    async () => Blob | null   (null means the file is gone)
 *   save       optional { attrs: {data-*...}, run: async (btn) => boolean } shown as "Save"
 * }
 */
export async function openFilePreview(opts) {
  const name = String((opts && opts.name) || 'file');
  const kind = previewKind(name);
  if (!kind || typeof opts.getBlob !== 'function') return false;
  closeFilePreview(true);

  const root = document.createElement('div');
  root.className = 'fv';
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-modal', 'true');
  root.setAttribute('aria-label', 'Preview of ' + (opts.title || name));
  root.innerHTML =
    '<div class="fv-scrim" data-fv-close></div>' +
    '<section class="fv-panel">' +
      '<header class="fv-bar">' +
        '<i class="ph ' + KIND_ICON[kind] + ' fv-kind" aria-hidden="true"></i>' +
        '<div class="fv-title"><span class="fv-name">' + escapeHtml(opts.title || name) + '</span>' +
          '<span class="fv-sub">' + escapeHtml(KIND_LABEL[kind] + (Number.isFinite(opts.size) ? ' · ' + formatSize(opts.size) : '')) + '</span></div>' +
        '<div class="fv-actions">' +
          (opts.save ? '<button type="button" class="fv-btn fv-save" title="Save to Cognita" aria-label="Save to Cognita"><i class="ph ph-cloud-arrow-up" aria-hidden="true"></i><span>Save</span></button>' : '') +
          '<button type="button" class="fv-btn fv-dl" title="Download" aria-label="Download" disabled><i class="ph ph-download-simple" aria-hidden="true"></i><span>Download</span></button>' +
          '<button type="button" class="fv-btn fv-x" title="Close" aria-label="Close preview"><i class="ph ph-x" aria-hidden="true"></i></button>' +
        '</div>' +
      '</header>' +
      '<div class="fv-body"><div class="fv-state"><i class="ph ph-circle-notch trace-spin" aria-hidden="true"></i> Opening preview…</div></div>' +
    '</section>';
  document.body.appendChild(root);

  const body = root.querySelector('.fv-body');
  const dlBtn = root.querySelector('.fv-dl');
  const saveBtn = root.querySelector('.fv-save');
  const closeBtn = root.querySelector('.fv-x');

  const c = {
    root, objectUrl: null, prevFocus: document.activeElement, prevOverflow: document.documentElement.style.overflow,
    onKey: null, onMsg: null, onFrameKey: null, blob: null,
  };
  current = c;
  document.documentElement.style.overflow = 'hidden';

  c.onKey = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeFilePreview(); return; }
    if (e.key !== 'Tab') return;
    const items = [...root.querySelectorAll('button:not([disabled])')];
    if (!items.length) return;
    const first = items[0], last = items[items.length - 1];
    if (!root.contains(document.activeElement)) { e.preventDefault(); first.focus(); }
    else if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  };
  document.addEventListener('keydown', c.onKey, true);
  // Esc pressed while the page or document itself has focus is sent up by the frame.
  c.onFrameKey = (ev) => {
    const fr = root.querySelector('.fv-frame');
    if (fr && ev.source === fr.contentWindow && ev.data && ev.data.t === 'file-preview-escape') closeFilePreview();
  };
  window.addEventListener('message', c.onFrameKey);
  root.addEventListener('click', (e) => { if (e.target.closest && e.target.closest('[data-fv-close]')) closeFilePreview(); });
  closeBtn.addEventListener('click', closeFilePreview);
  closeBtn.focus();

  const fail = (text) => { body.innerHTML = '<div class="fv-state fv-state-err">' + escapeHtml(text) + '</div>'; };

  let blob = null;
  try { blob = await opts.getBlob(); } catch (_) { blob = null; }
  if (current !== c) return false; // closed while loading
  if (!blob) { fail('This file is no longer available here. Ask Cognita to make it again.'); return false; }
  if (blob.size > MAX_BYTES) {
    fail('This file is too large to preview (' + formatSize(blob.size) + '). Download it instead.');
  }
  c.blob = blob;

  dlBtn.disabled = false;
  dlBtn.addEventListener('click', () => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  });
  if (saveBtn && opts.save) {
    Object.entries(opts.save.attrs || {}).forEach(([k, v]) => saveBtn.setAttribute(k, v));
    saveBtn.addEventListener('click', async () => {
      if (saveBtn.disabled) return;
      let ok = false;
      try { ok = await opts.save.run(saveBtn); } catch (_) { ok = false; }
      if (current !== c) return;
      if (ok) { saveBtn.disabled = true; saveBtn.innerHTML = '<i class="ph ph-check" aria-hidden="true"></i><span>Saved</span>'; }
      else { saveBtn.disabled = false; saveBtn.innerHTML = '<i class="ph ph-cloud-arrow-up" aria-hidden="true"></i><span>Save</span>'; }
    });
  }
  if (blob.size > MAX_BYTES) return false;

  // ── Show it ─────────────────────────────────────────────────────────
  if (kind === 'image') {
    c.objectUrl = URL.createObjectURL(blob.type ? blob : new Blob([blob], { type: 'image/png' }));
    body.innerHTML = '<div class="fv-image"><img alt="" src="' + c.objectUrl + '"></div>';
    body.querySelector('img').alt = opts.title || name;
    return true;
  }

  const frame = document.createElement('iframe');
  frame.className = 'fv-frame' + (kind === 'html' ? ' fv-frame-page' : '');
  frame.setAttribute('sandbox', 'allow-scripts');
  frame.setAttribute('referrerpolicy', 'no-referrer');
  frame.setAttribute('title', 'Preview of ' + (opts.title || name));

  let payload = null;
  if (kind === 'html') {
    const html = await blob.text();
    if (current !== c) return false;
    if (html.length > MAX_HTML_CHARS) { fail('This page is too large to preview. Download it to open it in your browser.'); return false; }
    payload = { t: 'html', html };
    frame.src = '/preview-frame';
  } else {
    const buffer = await blob.arrayBuffer();
    if (current !== c) return false;
    payload = { t: 'file', kind, name, buffer, theme: themeColours() };
    frame.src = '/file-preview';
  }

  c.onMsg = (ev) => {
    if (ev.source !== frame.contentWindow || !ev.data) return;
    if (ev.data.t !== 'preview-ready' && ev.data.t !== 'file-preview-ready') return;
    window.removeEventListener('message', c.onMsg);
    try {
      if (payload.buffer) frame.contentWindow.postMessage(payload, '*', [payload.buffer]);
      else frame.contentWindow.postMessage(payload, '*');
    } catch (_) { fail('This file could not be previewed. You can still download it.'); }
    payload = null;
  };
  window.addEventListener('message', c.onMsg);
  body.textContent = '';
  body.appendChild(frame);
  return true;
}

/** Shows a short note when a preview could not start. */
export function previewUnavailable() {
  showToast('That file is no longer on this device. Ask Cognita to make it again.');
}
