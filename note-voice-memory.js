// note-voice-memory.js
// Remembered voices for the Note Taker. A voiceprint is biometric data, so this file is deliberately cautious:
//   - Nothing is stored unless the person taps "Remember this voice" for a speaker they have named.
//   - Voiceprints live only in this browser (localStorage), under the signed-in user's id. They are never sent to the
//     server and never written into a note. Two people sharing one browser each see only their own list.
//   - A saved voice is only used to name a speaker when it is clearly the closest match AND clearly closer than the
//     runner-up. Anything doubtful stays "Speaker N": a missed name is a small nuisance, a wrong name is worse.
//
// What is stored for each voice: a name, the average timbre of the voice (12 numbers), its pitch, how much speech it was
// built from, the spread of those numbers in the meeting it came from (so distances stay fair between meetings), and
// the date. No audio is kept.

const KEY_PREFIX = 'cognitaNoteVoices:'
const VERSION = 1
export const MAX_VOICES = 12
export const MAX_NAME = 40
const NCEP = 12
const SKIP_DIMS = 2          // the two lowest timbre numbers mostly follow loudness and microphone, not the person
export const MATCH_MAX = 0.35 // closest saved voice must be nearer than this...
export const MATCH_GAP = 0.3  // ...and the runner-up must be at least this much farther away
export const MIN_FRAMES = 40  // about 2 seconds of clearly voiced speech; thinner voiceprints are never matched
const W_TIMBRE = 0.75, W_PITCH = 0.25, PITCH_SCALE = 0.12
const KEEP_OLD = 0.8          // how much of a saved voice survives each update: it changes slowly
const FRAME_CAP = 400
export const DEFAULT_NAME = /^Speaker \d+$/

const finite = (v) => typeof v === 'number' && Number.isFinite(v)
const vec = (a) => Array.isArray(a) && a.length === NCEP && a.every(finite)

export const cleanName = (raw) => String(raw ?? '').replace(/[:\[\]\n]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_NAME)
export const isRememberable = (name) => !!cleanName(name) && !DEFAULT_NAME.test(cleanName(name))

// ---------- Storage ----------
const keyFor = (uid) => `${KEY_PREFIX}${uid}`
function sanitize(raw) {
  const list = Array.isArray(raw?.voices) ? raw.voices : []
  const seen = new Set(), out = []
  for (const v of list) {
    const name = cleanName(v?.name)
    if (!name || !vec(v?.c) || !finite(v?.lf0) || !vec(v?.sigma) || !finite(v?.n) || v.n < 1 || seen.has(name.toLowerCase())) continue
    seen.add(name.toLowerCase())
    out.push({ name, c: v.c.slice(), lf0: v.lf0, n: Math.min(FRAME_CAP, Math.round(v.n)), sigma: v.sigma.map((s) => Math.max(0.15, s)), updatedAt: typeof v.updatedAt === 'string' ? v.updatedAt.slice(0, 40) : '' })
  }
  return out.slice(0, MAX_VOICES)
}
export function loadVoices(uid, storage = globalThis.localStorage) {
  if (!uid) return []
  try { return sanitize(JSON.parse(storage.getItem(keyFor(uid)) || 'null')) } catch { return [] }
}
// Returns false when it could not be written (storage full, blocked, or no signed-in user).
export function saveVoices(uid, voices, storage = globalThis.localStorage) {
  if (!uid) return false
  try {
    if (!voices.length) storage.removeItem(keyFor(uid))
    else storage.setItem(keyFor(uid), JSON.stringify({ v: VERSION, voices: sanitize({ voices }) }))
    return true
  } catch { return false }
}

// ---------- Comparing voices ----------
const pooled = (a, b) => a.map((s, k) => Math.sqrt((s * s + b[k] * b[k]) / 2))
// Distance between a voice heard in one meeting and a saved voice. The timbre numbers are divided by the spread the two
// meetings shared, so a voice is not judged against a yardstick from one room only. Same scale as VoiceTracker.dist().
export function voiceDistance(a, b) {
  const sig = pooled(a.sigma, b.sigma)
  let s = 0
  for (let k = SKIP_DIMS; k < NCEP; k++) { const d = (a.c[k] - b.c[k]) / sig[k]; s += d * d }
  const timbre = Math.sqrt(s / (NCEP - SKIP_DIMS)) * 3
  const pitch = Math.abs(a.lf0 - b.lf0) / PITCH_SCALE
  return Math.sqrt(W_TIMBRE * timbre * timbre + W_PITCH * pitch * pitch)
}

// clusters: [{ label, c, lf0, n }] from VoiceTracker.finalizeDetailed(); sigma: that meeting's spread. saved: stored voices.
// Returns a Map of label -> saved voice, for the clusters that can be named with confidence. Everything else is left out.
export function matchVoices(clusters, sigma, saved, opts = {}) {
  const max = opts.max ?? MATCH_MAX, gap = opts.gap ?? MATCH_GAP, minFrames = opts.minFrames ?? MIN_FRAMES
  const out = new Map()
  if (!saved?.length || !vec(sigma)) return out
  const claims = new Map() // saved voice name -> labels that chose it
  for (const cl of clusters || []) {
    if (!vec(cl?.c) || !finite(cl.lf0) || !(cl.n >= minFrames)) continue
    const probe = { c: cl.c, lf0: cl.lf0, sigma }
    const ranked = saved.map((v) => ({ v, d: voiceDistance(probe, v) })).sort((x, y) => x.d - y.d)
    const [best, second] = ranked
    if (!best || best.v.n < minFrames || !(best.d < max)) continue
    if (second && second.d - best.d < gap) continue
    claims.set(best.v.name, [...(claims.get(best.v.name) || []), cl.label])
    out.set(cl.label, best.v)
  }
  // Two voices in one meeting both claiming the same saved person means at least one is wrong, and we cannot tell which.
  for (const labels of claims.values()) if (labels.length > 1) for (const l of labels) out.delete(l)
  return out
}

// ---------- Changing the list ----------
// Saves the voice of a speaker under a name. A name already in the list is updated slowly, so one odd meeting cannot
// overwrite it; a new name is added if there is room. Returns { voices, status } with status 'added' | 'updated' | 'full'.
export function rememberVoice(voices, name, cluster, sigma, now = new Date()) {
  name = cleanName(name)
  if (!isRememberable(name) || !vec(cluster?.c) || !finite(cluster.lf0) || !vec(sigma) || !(cluster.n >= 1)) return { voices, status: 'invalid' }
  const at = now.toISOString(), i = voices.findIndex((v) => v.name.toLowerCase() === name.toLowerCase())
  if (i >= 0) return { voices: voices.map((v, k) => (k === i ? blend(v, cluster, sigma, at) : v)), status: 'updated' }
  if (voices.length >= MAX_VOICES) return { voices, status: 'full' }
  return { voices: [...voices, { name, c: cluster.c.slice(), lf0: cluster.lf0, n: Math.min(FRAME_CAP, Math.round(cluster.n)), sigma: sigma.map((s) => Math.max(0.15, s)), updatedAt: at }], status: 'added' }
}
function blend(old, cl, sigma, at) {
  const k = KEEP_OLD
  return {
    name: old.name, updatedAt: at,
    c: old.c.map((x, j) => x * k + cl.c[j] * (1 - k)),
    lf0: old.lf0 * k + cl.lf0 * (1 - k),
    sigma: old.sigma.map((x, j) => Math.max(0.15, x * k + sigma[j] * (1 - k))),
    n: Math.min(FRAME_CAP, old.n + Math.round(cl.n * (1 - k))),
  }
}
export const forgetVoice = (voices, name) => voices.filter((v) => v.name.toLowerCase() !== String(name).toLowerCase())
