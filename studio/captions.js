// studio/captions.js
// SRT and VTT import (tolerant of real-world files) and export. Pure functions, no DOM.

export const MAX_CUES = 5000;
export const MAX_SUB_BYTES = 2 * 1048576;

const TS = /(?:(\d{1,3}):)?(\d{1,2}):(\d{2})(?:[.,](\d{1,3}))?/;
function parseTime(s) {
  const m = TS.exec(s); if (!m) return NaN;
  const h = m[1] ? Number(m[1]) : 0, mi = Number(m[2]), se = Number(m[3]); const ms = m[4] ? Number((m[4] + '00').slice(0, 3)) : 0;
  if (mi > 59 || se > 59) return NaN;
  return h * 3600 + mi * 60 + se + ms / 1000;
}
const cleanText = (t) => t.replace(/<[^>]*>/g, '').replace(/\{\\[^}]*\}/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').split('\n').map((l) => l.trim()).filter(Boolean).join('\n').slice(0, 500);

// Returns { cues: [{start, end, text}], warnings: [string] }. Throws a readable Error when nothing usable is found.
export function parseSubtitles(raw) {
  if (typeof raw !== 'string') throw new Error('This subtitle file could not be read as text.');
  if (raw.length > MAX_SUB_BYTES) throw new Error('This subtitle file is too large (over 2 MB).');
  const text = raw.replace(/^﻿/, '').replace(/\r\n?/g, '\n').trim();
  if (!text) throw new Error('This subtitle file is empty.');
  const blocks = text.split(/\n{2,}/); const cues = []; const warnings = []; let bad = 0;
  for (const b of blocks) {
    const lines = b.split('\n'); const first = lines[0].trim();
    if (/^(WEBVTT|NOTE|STYLE|REGION)\b/.test(first)) continue;
    const ti = lines.findIndex((l) => l.includes('-->')); if (ti < 0) { if (b.trim()) bad++; continue; }
    const [a, rest] = lines[ti].split('-->'); const bpart = (rest || '').trim().split(/\s+/)[0];
    const s = parseTime(a.trim()), e = parseTime(bpart);
    const body = cleanText(lines.slice(ti + 1).join('\n'));
    if (!Number.isFinite(s) || !Number.isFinite(e) || e <= s || !body) { bad++; continue; }
    cues.push({ start: s, end: e, text: body });
    if (cues.length >= MAX_CUES) { warnings.push('Only the first ' + MAX_CUES + ' cues were imported.'); break; }
  }
  if (!cues.length) throw new Error('No subtitle cues were found. Check that this is an .srt or .vtt file.');
  if (bad) warnings.push(bad + ' block' + (bad === 1 ? ' was' : 's were') + ' skipped because the timing or text could not be read.');
  cues.sort((x, y) => x.start - y.start);
  return { cues, warnings };
}

const z = (n, w = 2) => String(n).padStart(w, '0');
function stamp(t, sep) { t = Math.max(0, t); const ms = Math.round(t * 1000); const h = Math.floor(ms / 3600000), m = Math.floor((ms % 3600000) / 60000), s = Math.floor((ms % 60000) / 1000), r = ms % 1000; return `${z(h)}:${z(m)}:${z(s)}${sep}${z(r, 3)}`; }
// cues: [{ start, end, text }]
export function toSRT(cues) { return cues.map((c, i) => `${i + 1}\n${stamp(c.start, ',')} --> ${stamp(c.end, ',')}\n${c.text}\n`).join('\n'); }
export function toVTT(cues) { return 'WEBVTT\n\n' + cues.map((c, i) => `${i + 1}\n${stamp(c.start, '.')} --> ${stamp(c.end, '.')}\n${c.text}\n`).join('\n'); }
