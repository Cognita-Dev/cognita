// studio/storyboard.js
// Turns a request into a validated video project by asking Cognita's existing /api/chat endpoint.
// The Worker still picks the model; this file only sends a prompt and reads the reply.

import { uid } from './store.js';

export const WORKER_URL = 'https://api.cognita.com.ng';

export const LAYOUTS = ['title', 'bullets', 'quote', 'stat', 'chart', 'kinetic', 'image', 'video'];
export const ANIMS = ['fade', 'slide', 'zoom'];
export const STYLES = ['clean', 'dark', 'bold'];
export const ASPECTS = ['9:16', '16:9', '1:1'];
export const MUSIC = ['none', 'calm', 'upbeat'];
export const TRANSITIONS = ['fade', 'slide', 'wipe', 'zoom', 'none'];

const SCHEMA = `{
  "title": "short project title",
  "clarify": "ONLY include this field (and nothing else) if the request is too vague to build a video; ask ONE short question",
  "scenes": [
    {
      "title": "scene headline, max 8 words",
      "layout": "title | bullets | quote | stat | chart | kinetic | image | video",
      "text": "supporting line, max 20 words (for quote layout: the quote)",
      "bullets": ["max 4 short points, only for bullets layout"],
      "stat": "a number with optional unit such as 85% or 12,000 (only for stat layout)",
      "data": [{"label": "short label", "value": 42}],
      "caption": "the narration sentence, shown as a subtitle and spoken in the video, max 25 words",
      "duration": 5,
      "anim": "fade | slide | zoom",
      "transition": "fade | slide | wipe | zoom | none",
      "imageIndex": 0,
      "videoIndex": 0,
      "imagePrompt": "image layout only: a concrete picture description, max 25 words, no text or logos in the picture"
    }
  ]
}`;

function clamp(n, lo, hi, d) { n = Number(n); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; }
const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

export function extractJson(text) {
  if (typeof text !== 'string') return null;
  const clean = text.replace(/```(?:json)?/gi, '');
  const a = clean.indexOf('{');
  const b = clean.lastIndexOf('}');
  if (a === -1 || b <= a) return null;
  try { return JSON.parse(clean.slice(a, b + 1)); } catch (_) { return null; }
}

export function normaliseScene(raw, imageIds = [], videoIds = []) {
  raw = raw && typeof raw === 'object' ? raw : {};
  let layout = LAYOUTS.includes(raw.layout) ? raw.layout : 'title';
  let image = null, video = null;
  if (Number.isInteger(raw.imageIndex) && imageIds[raw.imageIndex]) image = imageIds[raw.imageIndex];
  if (typeof raw.image === 'string' && imageIds.includes(raw.image)) image = raw.image;
  if (Number.isInteger(raw.videoIndex) && videoIds[raw.videoIndex]) video = videoIds[raw.videoIndex];
  if (typeof raw.video === 'string' && videoIds.includes(raw.video)) video = raw.video;
  const imagePrompt = str(raw.imagePrompt, 300);
  if (layout === 'video' && !video) layout = 'title';
  if (layout === 'image' && !image && !imagePrompt) layout = 'title';
  const data = Array.isArray(raw.data) ? raw.data.map((r) => ({ label: str(r && r.label, 30), value: Number.isFinite(Number(r && r.value)) ? Number(r.value) : 0 })).filter((r) => r.label).slice(0, 6) : [];
  if (layout === 'chart' && data.length < 2) layout = 'title';
  const narr = raw.narr && typeof raw.narr === 'object' && typeof raw.narr.key === 'string' && raw.narr.dur > 0 ? { key: raw.narr.key.slice(0, 20), dur: Number(raw.narr.dur), voice: str(raw.narr.voice, 20), rate: Number(raw.narr.rate) || 1, engine: str(raw.narr.engine, 20) } : null;
  return {
    id: typeof raw.id === 'string' && raw.id ? raw.id : uid('sc'),
    title: str(raw.title, 90), layout, text: str(raw.text, 220),
    bullets: Array.isArray(raw.bullets) ? raw.bullets.map((b) => str(b, 90)).filter(Boolean).slice(0, 5) : [],
    stat: str(raw.stat, 24), data,
    caption: str(raw.caption, 240),
    duration: clamp(raw.duration, 2, 20, 5),
    anim: ANIMS.includes(raw.anim) ? raw.anim : 'fade',
    transition: TRANSITIONS.includes(raw.transition) ? raw.transition : 'fade',
    bg: /^#[0-9a-f]{6}$/i.test(raw.bg || '') ? raw.bg : '',
    image, video, imagePrompt,
    trimStart: clamp(raw.trimStart, 0, 36000, 0),
    keepAudio: !!raw.keepAudio,
    narr,
  };
}

export function normaliseProject(raw, base = {}, imageIds = [], videoIds = []) {
  const scenes = (Array.isArray(raw.scenes) ? raw.scenes : []).slice(0, 14).map((s) => normaliseScene(s, imageIds, videoIds));
  return {
    ...base,
    title: str(raw.title, 80) || base.title || 'Untitled video',
    aspect: ASPECTS.includes(raw.aspect) ? raw.aspect : (base.aspect || '9:16'),
    style: STYLES.includes(raw.style) ? raw.style : (base.style || 'clean'),
    music: MUSIC.includes(raw.music) ? raw.music : (base.music || 'none'),
    lang: base.lang, voice: base.voice, rate: base.rate, language: base.language,
    captions: typeof raw.captions === 'boolean' ? raw.captions : (base.captions !== false),
    scenes,
  };
}

// Sends one prompt to /api/chat and resolves with the final reply text.
async function ask(prompt) {
  if (!navigator.onLine) throw new Error('You appear to be offline. Connect to the internet to use the AI.');
  const res = await window.Auth.authedFetch(WORKER_URL + '/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messages: [{ role: 'user', content: prompt }],
      quality: 'standard',
      conversationId: uid('studio'),
    }),
  });
  if (!res.ok) {
    let d = {};
    try { d = await res.json(); } catch (_) { /* ignore */ }
    const e = new Error(d.error || 'Cognita could not process this request (status ' + res.status + ').');
    e.status = res.status;
    throw e;
  }
  if (!res.body || !res.body.getReader) {
    const d = await res.json();
    return d.reply || '';
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let reply = null;
  let failure = null;
  const eat = () => {
    let i;
    while ((i = buf.indexOf('\n\n')) !== -1) {
      const raw = buf.slice(0, i);
      buf = buf.slice(i + 2);
      if (!raw || raw.startsWith(':')) continue;
      let name = 'message';
      const lines = [];
      raw.split('\n').forEach((l) => {
        if (l.startsWith('event:')) name = l.slice(6).trim();
        else if (l.startsWith('data:')) lines.push(l.slice(5).trimStart());
      });
      if (!lines.length) continue;
      let data;
      try { data = JSON.parse(lines.join('\n')); } catch (_) { continue; }
      if (name === 'done') reply = data.reply || '';
      else if (name === 'error') failure = data.message || 'Something went wrong.';
    }
  };
  for (;;) {
    const { done, value } = await reader.read();
    if (value) { buf += dec.decode(value, { stream: true }); eat(); }
    if (done) { buf += '\n\n'; eat(); break; }
  }
  if (failure) throw new Error(failure);
  if (reply == null) throw new Error('The response ended before it was complete. Please try again.');
  return reply;
}

export async function generateStoryboard({ prompt, mode, options, imageCount, videoClips, sourceText }) {
  const o = options;
  const lines = [
    'You are the storyboard engine inside Cognita Studio, a browser video maker. Reply with ONE JSON object only. No markdown, no commentary.',
    'Schema:', SCHEMA,
    'Rules: plain factual language, no emojis, no hype. Total runtime close to ' + o.duration + ' seconds. Format ' + o.aspect + '. Language: ' + o.language + '.',
    'Start with a title scene and end with a closing scene. Use at most 12 scenes. Vary the layouts: use "chart" only when you have real numbers from the request, "stat" for one key number, "kinetic" for a short punchy statement (under 10 words), "quote" for a quotation.',
    'Every scene needs a caption written as natural spoken narration, a full sentence, under 25 words. The caption is what a narrator will say, so write it to be heard.',
    'Use "transition" sparingly. Default "fade".',
  ];
  if (imageCount) lines.push('The user supplied ' + imageCount + ' image(s), indexed from 0. Use each one in a scene with layout "image" and imageIndex.');
  if (o.aiImages && mode !== 'footage') lines.push('For up to 4 scenes where a picture helps, use layout "image" with an "imagePrompt". Picture descriptions must be concrete and safe for all ages.');
  else if (!imageCount) lines.push('Do not use the "image" or "video" layouts.');
  if (mode === 'footage') lines.push('The user supplied ' + videoClips.length + ' video clip(s), indexed from 0: ' + videoClips.map((c, i) => i + ' = "' + c.name + '" (' + Math.round(c.duration) + ' s)').join('; ') + '. Build one scene with layout "video" and videoIndex per clip, in order, with a title and caption describing it from the user request. Add a title scene at the start and a closing scene at the end. Do not invent what is in a clip beyond what the user says.');
  if (mode === 'document' && sourceText) lines.push('Turn this source text into the video, keeping its facts:\n"""\n' + sourceText.slice(0, 9000) + '\n"""');
  lines.push('User request: ' + (prompt || '(none, build from the supplied material)'));
  const reply = await ask(lines.join('\n'));
  const json = extractJson(reply);
  if (!json) throw new Error('The AI reply could not be read as a storyboard. Please try again.');
  return json;
}

export async function editProject(project, instruction, imageIds, videoIds = []) {
  const lite = JSON.parse(JSON.stringify({ title: project.title, aspect: project.aspect, style: project.style, music: project.music, captions: project.captions, scenes: project.scenes.map((s) => { const c = { ...s }; delete c.narr; return c; }) }));
  const prompt = [
    'You edit a video project in Cognita Studio. Apply the instruction to the project JSON and reply with ONE JSON object only: {"summary":"one sentence describing what changed","project":{...full updated project...}}.',
    'Keep every scene id unchanged. Keep fields you were not asked to change. Allowed layouts: ' + LAYOUTS.join(', ') + ' (never switch a scene to image or video unless it already has one). Allowed transition: ' + TRANSITIONS.join(', ') + '. Allowed anim: ' + ANIMS.join(', ') + '. Allowed style: ' + STYLES.join(', ') + '. Allowed aspect: ' + ASPECTS.join(', ') + '. Allowed music: ' + MUSIC.join(', ') + '. bg is an optional #rrggbb colour.',
    'If the instruction cannot be done with these fields, reply {"summary":"","unsupported":"why it cannot be done and what could be done instead"}.',
    'Instruction: ' + instruction,
    'Project: ' + JSON.stringify(lite),
  ].join('\n');
  const reply = await ask(prompt);
  const json = extractJson(reply);
  if (!json) throw new Error('The edit reply could not be read. Please rephrase and try again.');
  if (json.unsupported) return { unsupported: String(json.unsupported).slice(0, 300) };
  if (!json.project || !Array.isArray(json.project.scenes) || !json.project.scenes.length) throw new Error('The edit did not return a valid project.');
  return { summary: str(json.summary, 200) || 'Project updated.', project: mergeNarration(normaliseProject(json.project, project, imageIds, videoIds), project) };
}

// Keeps narration where the caption did not change; the engine marks the rest outdated by comparing keys.
function mergeNarration(next, prev) {
  const byId = new Map(prev.scenes.map((s) => [s.id, s]));
  next.scenes.forEach((s) => { const old = byId.get(s.id); if (old && old.narr && !s.narr) s.narr = old.narr; if (old) { if (!s.video && old.video && s.layout === 'video') s.video = old.video; if (old.video && s.video === old.video) { s.trimStart = old.trimStart; s.keepAudio = old.keepAudio; } } });
  return next;
}
