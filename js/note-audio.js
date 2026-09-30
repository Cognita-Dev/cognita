// note-audio.js
// Records the whole meeting as one small audio file, next to the transcript, so a note can be played back later.
// Separate from the short chunks the cloud transcriber uses: this one runs for the entire session, is paused when
// the note is paused (so the audio timeline matches the transcript timestamps, which also skip pauses), and is kept in
// memory until the person saves the note. Speech is stored at a low bitrate: about 11 MB an hour.

const MIMES = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus']
const BITS_PER_SECOND = 24000
const HARD_MAX_BYTES = 30 * 1024 * 1024 // the same ceiling the Worker enforces

export const audioSupported = () => !!window.MediaRecorder
const pickMime = () => MIMES.find((t) => window.MediaRecorder?.isTypeSupported?.(t)) || ''

export class SessionRecorder {
  constructor(stream, maxBytes = HARD_MAX_BYTES) {
    this.stream = stream
    this.maxBytes = Math.min(maxBytes, HARD_MAX_BYTES)
    this.parts = []; this.bytes = 0; this.truncated = false; this.rec = null
  }
  start() {
    const mimeType = pickMime()
    try { this.rec = new MediaRecorder(this.stream, { ...(mimeType ? { mimeType } : {}), audioBitsPerSecond: BITS_PER_SECOND }) }
    catch { this.rec = null; return false }
    this.rec.ondataavailable = (e) => {
      if (!e.data?.size || this.truncated) return
      if (this.bytes + e.data.size > this.maxBytes) { // out of room: keep what we have, the transcript carries on
        this.truncated = true
        try { if (this.rec.state !== 'inactive') this.rec.stop() } catch {}
        return
      }
      this.parts.push(e.data); this.bytes += e.data.size
    }
    this.rec.onerror = () => { this.failed = true }
    this.rec.start(4000)
    return true
  }
  pause() { try { if (this.rec?.state === 'recording') this.rec.pause() } catch {} }
  resume() { try { if (this.rec?.state === 'paused') this.rec.resume() } catch {} }
  // Ends the recording and returns { blob, type, truncated }, or null when nothing usable was captured.
  stop() {
    return new Promise((resolve) => {
      const done = () => {
        if (!this.parts.length) return resolve(null)
        const type = (this.rec?.mimeType || pickMime() || 'audio/webm').split(';')[0]
        resolve({ blob: new Blob(this.parts, { type }), type, truncated: this.truncated })
      }
      if (!this.rec || this.rec.state === 'inactive') return done()
      this.rec.addEventListener('stop', done, { once: true })
      try { this.rec.stop() } catch { done() }
    })
  }
  discard() { try { if (this.rec && this.rec.state !== 'inactive') this.rec.stop() } catch {} this.parts = []; this.bytes = 0 }
}
