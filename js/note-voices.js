// note-voices.js
// Free, on-device speaker separation for the Note Taker. No server, no model download, no cost.
//
// How it works: while people talk, the microphone signal is cut into ~43 ms frames. For every frame that is loud and
// clearly voiced (a vowel, where the vocal cords are vibrating) we measure two things about the voice:
//   - pitch: how fast the vocal cords vibrate (a deep voice is low, a high voice is high), and
//   - timbre: 12 MFCC numbers, a compact description of the spectral shape that the speaker's throat and mouth give
//     the sound (this is what makes two people at the same pitch still sound different).
// Each transcript segment gets the average of the frames spoken during it, and segments are grouped by how close
// those averages are. The audio never leaves the browser.
//
// Honest limits: this separates voices that differ (an adult man and woman, or two men with different timbre). Similar
// voices can be merged, one person who changes pitch a lot can be split, overlapping speech gets one label, and very
// short interjections take the previous label. That is why every label in the app can be corrected by hand.

export const FRAME = 2048;
const NMEL = 24;
const NCEP = 12;
const MEL_LO = 100, MEL_HI = 4500;
const F0_LO = 70, F0_HI = 400;
const MIN_PERIODICITY = 0.5;
const MIN_FRAMES = 8;            // about 0.4 s of voiced speech before a segment is trusted to carry a voiceprint
export const MAX_SPEAKERS = 6;
const INTERNAL_MAX = 10;         // clusters allowed while recording; merged down at the end
const NEW_SPEAKER_DIST = 1.45;   // segment-to-voice distance above which a new voice is opened (online)
const MERGE_DIST = 1.0;          // two voices closer than this at the end are the same person
const STICKY = 0.92;             // turns are long: the previous speaker gets a small head start
const KEEP_MS = 120000;

// ---------- Signal processing ----------

const twiddles = new Map();
function fft(re, im) {
  const n = re.length;
  let tw = twiddles.get(n);
  if (!tw) {
    const rev = new Uint32Array(n), bits = Math.log2(n);
    for (let i = 0; i < n; i++) { let r = 0; for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b); rev[i] = r; }
    const cos = new Float64Array(n / 2), sin = new Float64Array(n / 2);
    for (let i = 0; i < n / 2; i++) { cos[i] = Math.cos((2 * Math.PI * i) / n); sin[i] = -Math.sin((2 * Math.PI * i) / n); }
    tw = { rev, cos, sin }; twiddles.set(n, tw);
  }
  const { rev, cos, sin } = tw;
  for (let i = 0; i < n; i++) { const j = rev[i]; if (j > i) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; } }
  for (let size = 2; size <= n; size <<= 1) {
    const half = size >> 1, step = n / size;
    for (let start = 0; start < n; start += size) {
      for (let k = 0, w = 0; k < half; k++, w += step) {
        const a = start + k, b = a + half;
        const tr = re[b] * cos[w] - im[b] * sin[w], ti = re[b] * sin[w] + im[b] * cos[w];
        re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
      }
    }
  }
}

const hz2mel = (f) => 2595 * Math.log10(1 + f / 700);
const mel2hz = (m) => 700 * (10 ** (m / 2595) - 1);

export function createExtractor(sampleRate) {
  const window = new Float64Array(FRAME); for (let i = 0; i < FRAME; i++) window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (FRAME - 1));
  const hi = Math.min(MEL_HI, sampleRate / 2 - 100);
  const edges = Array.from({ length: NMEL + 2 }, (_, i) => mel2hz(hz2mel(MEL_LO) + ((hz2mel(hi) - hz2mel(MEL_LO)) * i) / (NMEL + 1)));
  const binHz = sampleRate / FRAME;
  const filters = Array.from({ length: NMEL }, (_, m) => {
    const lo = edges[m], mid = edges[m + 1], up = edges[m + 2], taps = [];
    for (let b = Math.floor(lo / binHz); b <= Math.ceil(up / binHz); b++) {
      const f = b * binHz, w = f <= lo || f >= up ? 0 : f < mid ? (f - lo) / (mid - lo) : (up - f) / (up - mid);
      if (w > 0 && b < FRAME / 2) taps.push([b, w]);
    }
    return taps;
  });
  const dct = Array.from({ length: NCEP }, (_, k) => Float64Array.from({ length: NMEL }, (_, m) => Math.cos((Math.PI * (k + 1) * (m + 0.5)) / NMEL)));
  const decim = Math.max(1, Math.round(sampleRate / 16000)), sr = sampleRate / decim;
  const lagLo = Math.floor(sr / F0_HI), lagHi = Math.min(Math.ceil(sr / F0_LO), Math.floor((FRAME / decim) / 2));
  const re = new Float64Array(FRAME), im = new Float64Array(FRAME);

  function rmsOf(x) { let s = 0; for (let i = 0; i < x.length; i++) s += x[i] * x[i]; return Math.sqrt(s / x.length); }

  // Pitch by normalised autocorrelation on a 16 kHz copy. Returns { f0, periodicity } or null.
  function pitch(x) {
    const n = Math.floor(x.length / decim), y = new Float64Array(n);
    for (let i = 0; i < n; i++) { let s = 0; for (let d = 0; d < decim; d++) s += x[i * decim + d]; y[i] = s / decim; }
    const ac = new Float64Array(lagHi + 2);
    for (let lag = lagLo - 1; lag <= lagHi + 1; lag++) {
      let num = 0, e1 = 0, e2 = 0;
      for (let i = 0; i + lag < n; i++) { num += y[i] * y[i + lag]; e1 += y[i] * y[i]; e2 += y[i + lag] * y[i + lag]; }
      ac[lag] = num / (Math.sqrt(e1 * e2) + 1e-12);
    }
    let best = 0; for (let lag = lagLo; lag <= lagHi; lag++) if (ac[lag] > ac[best]) best = lag;
    if (!best) return null;
    // Prefer the shortest lag that is nearly as strong: a strong peak at twice the period is a common octave error.
    let pick = best;
    for (let lag = lagLo; lag < best; lag++) if (ac[lag] >= ac[lag - 1] && ac[lag] >= ac[lag + 1] && ac[lag] >= 0.85 * ac[best]) { pick = lag; break; }
    const a = ac[pick - 1], b = ac[pick], c = ac[pick + 1], d = a - 2 * b + c;
    const shift = d ? (0.5 * (a - c)) / d : 0;
    const periodicity = b;
    return periodicity >= MIN_PERIODICITY ? { f0: sr / (pick + Math.max(-1, Math.min(1, shift))), periodicity } : null;
  }

  function mfcc(x) {
    for (let i = 0; i < FRAME; i++) { re[i] = (x[i] || 0) * window[i]; im[i] = 0; }
    fft(re, im);
    const logE = new Float64Array(NMEL);
    for (let m = 0; m < NMEL; m++) { let e = 0; for (const [b, w] of filters[m]) e += w * (re[b] * re[b] + im[b] * im[b]); logE[m] = Math.log(e + 1e-9); }
    return Float64Array.from(dct, (row) => { let s = 0; for (let m = 0; m < NMEL; m++) s += row[m] * logE[m]; return s / NMEL; });
  }
  return { rmsOf, pitch, mfcc };
}

// ---------- Voiceprints and clustering ----------

const median = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };

export class VoiceTracker {
  constructor(sampleRate) {
    this.ex = createExtractor(sampleRate)
    this.reset()
  }
  reset() {
    this.frames = []; this.floor = 0.02
    this.cnt = 0; this.mean = new Float64Array(NCEP); this.m2 = new Float64Array(NCEP) // running spread of frame features
    this.clusters = []; this.prev = -1; this.segments = []; this.cut = Date.now()
  }
  // One frame of raw microphone samples (Float32Array of FRAME). t is Date.now() when it was captured.
  push(x, t) {
    const rms = this.ex.rmsOf(x)
    this.floor = Math.min(this.floor * 1.003 + 1e-5, rms) // quiet-room level; rises slowly, drops at once
    // The gate follows the room's quiet level but is capped: if someone starts talking at once and never pauses, the
    // "quiet level" would otherwise creep up to speech level and reject everything. Noise is still kept out by the
    // periodicity test in pitch(), which only passes vibrating vocal cords.
    if (rms < Math.min(0.015, Math.max(0.006, this.floor * 2.5))) return
    const p = this.ex.pitch(x); if (!p) return
    const c = this.ex.mfcc(x)
    this.frames.push({ t, c, lf0: Math.log(p.f0) })
    while (this.frames.length && t - this.frames[0].t > KEEP_MS) this.frames.shift()
    this.cnt++
    for (let k = 0; k < NCEP; k++) { const d = c[k] - this.mean[k]; this.mean[k] += d / this.cnt; this.m2[k] += d * (c[k] - this.mean[k]) }
  }
  sigma(k) { return this.cnt > 20 ? Math.max(0.15, Math.sqrt(this.m2[k] / this.cnt)) : 1 }
  // The voiceprint of everything voiced between t0 and t1 (ms), or null when there was too little speech to judge.
  print(t0, t1) {
    const fr = this.frames.filter((f) => f.t >= t0 && f.t <= t1)
    if (fr.length < MIN_FRAMES) return null
    const c = new Float64Array(NCEP)
    for (const f of fr) for (let k = 0; k < NCEP; k++) c[k] += f.c[k] / fr.length
    return { c, lf0: median(fr.map((f) => f.lf0)), n: fr.length, start: fr[0].t }
  }
  dist(a, b) {
    let s = 0
    for (let k = 0; k < NCEP; k++) { const d = (a.c[k] - b.c[k]) / this.sigma(k); s += d * d }
    const timbre = Math.sqrt(s / NCEP) * 3 // frame-level spread dwarfs segment-level spread; scale back up
    const pitch = Math.abs(a.lf0 - b.lf0) / 0.12
    return Math.sqrt(0.55 * timbre * timbre + 0.45 * pitch * pitch)
  }
  // Live labelling. Returns the speaker index (0-based) for a segment spoken between t0 and t1.
  assign(t0, t1) {
    const p = this.print(t0, t1)
    if (!p) { this.segments.push(null); return Math.max(0, this.prev) } // too short to tell: keep the current speaker
    let best = -1, bestD = Infinity
    this.clusters.forEach((cl, i) => { const d = this.dist(p, cl) * (i === this.prev ? STICKY : 1); if (d < bestD) { bestD = d; best = i } })
    if (best < 0 || (bestD > NEW_SPEAKER_DIST && this.clusters.length < INTERNAL_MAX)) {
      this.clusters.push({ c: Float64Array.from(p.c), lf0: p.lf0, n: p.n }); best = this.clusters.length - 1
    } else {
      const cl = this.clusters[best], w = Math.min(cl.n, 400), tot = w + p.n
      for (let k = 0; k < NCEP; k++) cl.c[k] = (cl.c[k] * w + p.c[k] * p.n) / tot
      cl.lf0 = (cl.lf0 * w + p.lf0 * p.n) / tot; cl.n = Math.min(400, cl.n + p.n)
    }
    this.prev = best
    this.segments.push({ p, label: best })
    return best
  }
  // Best labels for every segment once the recording is over. Merges voices that are really one person, then lets
  // every segment pick its nearest voice again with the final, better-informed voiceprints. Returns one label (0-based,
  // numbered by first appearance) per segment passed to assign(), in order.
  finalize() {
    const segs = this.segments
    const clusters = this.clusters.map((c) => ({ c: Float64Array.from(c.c), lf0: c.lf0, n: c.n }))
    const merge = (i, j) => {
      const a = clusters[i], b = clusters[j], tot = a.n + b.n
      for (let k = 0; k < NCEP; k++) a.c[k] = (a.c[k] * a.n + b.c[k] * b.n) / tot
      a.lf0 = (a.lf0 * a.n + b.lf0 * b.n) / tot; a.n = tot; clusters.splice(j, 1)
    }
    for (;;) {
      let bi = -1, bj = -1, bd = Infinity
      for (let i = 0; i < clusters.length; i++) for (let j = i + 1; j < clusters.length; j++) { const d = this.dist(clusters[i], clusters[j]); if (d < bd) { bd = d; bi = i; bj = j } }
      if (bi < 0 || !(bd < MERGE_DIST || clusters.length > MAX_SPEAKERS)) break
      merge(bi, bj)
    }
    let labels = segs.map((s) => (s ? nearest(this, clusters, s.p) : -1))
    // A "voice" that only ever explains one segment is almost always a cough, a laugh or a burst of noise, not a person.
    for (let guard = 0; guard < INTERNAL_MAX && clusters.length > 1; guard++) {
      const lone = clusters.findIndex((_, i) => labels.filter((l) => l === i).length <= 1)
      if (lone < 0) break
      let bj = -1, bd = Infinity
      clusters.forEach((cl, j) => { if (j !== lone) { const d = this.dist(clusters[lone], cl); if (d < bd) { bd = d; bj = j } } })
      const keep = Math.min(lone, bj), drop = Math.max(lone, bj)
      merge(keep, drop)
      labels = segs.map((s) => (s ? nearest(this, clusters, s.p) : -1))
    }
    for (let iter = 0; iter < 3 && clusters.length > 1; iter++) { // Lloyd: recompute each voice from its segments, then reassign
      for (let i = 0; i < clusters.length; i++) {
        const mine = segs.filter((s, idx) => s && labels[idx] === i); if (!mine.length) continue
        const tot = mine.reduce((n, s) => n + s.p.n, 0), c = new Float64Array(NCEP); let lf = 0
        for (const s of mine) { for (let k = 0; k < NCEP; k++) c[k] += (s.p.c[k] * s.p.n) / tot; lf += (s.p.lf0 * s.p.n) / tot }
        clusters[i] = { c, lf0: lf, n: tot }
      }
      labels = segs.map((s) => (s ? nearest(this, clusters, s.p) : -1))
    }
    // Number voices by first appearance; unjudged segments inherit the previous label.
    const order = new Map(); let last = 0
    return labels.map((l) => { if (l < 0) return last; if (!order.has(l)) order.set(l, order.size); return (last = order.get(l)) })
  }
}
function nearest(tracker, clusters, p) { let best = 0, bd = Infinity; clusters.forEach((cl, i) => { const d = tracker.dist(p, cl); if (d < bd) { bd = d; best = i } }); return best }
