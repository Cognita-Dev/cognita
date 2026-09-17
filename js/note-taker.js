import { createNoteSession, patchNoteSession, persistNoteSegment, recoverNoteSession, transcribeChunk } from './note-taker-production.js'

const $ = (id) => document.getElementById(id)
const modal = $('noteTakerModal')
const RECOVERY_KEY = 'cognitaNoteTakerSession'
const CHUNK_MS = 8000
const MAX_SPEECH_FAILURES = 3
const AUTOSAVE_MS = 20000
const RETRY_PRIMARY_MS = 30000
const MIME_CANDIDATES = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus']
const Speech = window.SpeechRecognition || window.webkitSpeechRecognition

let stream, analyser, audioCtx, sourceNode, raf, timer
let chunkRecorder = null, chunkLoopRunning = false, chunkQueue = Promise.resolve()
let recognition, speechFailures = 0, retryTimer = null, intentionalRecognitionStop = false
let autosaveTimer = null
let startedAt, pausedMs = 0, pauseAt
let segments = [], interim = ''
let state = 'idle' // idle | requesting-permission | connecting | recording | paused | degraded | stopping | completed | error
let sessionId = null, sessionVersion = 1

function formatTime(ms) { const s = Math.floor(ms / 1000); return [Math.floor(s / 3600), Math.floor(s / 60) % 60, s % 60].map((n) => String(n).padStart(2, '0')).join(':') }
function elapsed() { return startedAt ? formatTime(Date.now() - startedAt - pausedMs - (pauseAt ? Date.now() - pauseAt : 0)) : '00:00:00' }
function setStatus(text, connection = '') { $('noteTakerStatus').textContent = text; $('noteTakerConnection').textContent = connection }
function escapeHtml(v) { return v.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])) }
function render() {
  const root = $('noteTakerTranscript')
  root.innerHTML = segments.map((s) => `<p class="note-segment"><time>${s.time}</time><span>${escapeHtml(s.text)}</span></p>`).join('') +
    (interim ? `<p class="note-segment interim"><time></time><span>${escapeHtml(interim)}</span></p>` : '') ||
    '<p class="note-taker-empty">Your transcript will appear here as people speak.</p>'
  root.scrollTop = root.scrollHeight
}
function saveRecoveryPointer() { if (sessionId) localStorage.setItem(RECOVERY_KEY, JSON.stringify({ sessionId, version: sessionVersion, title: $('noteTakerMeetingTitle').value.trim(), language: $('noteTakerLanguage').value, startedAt })) }
function clearRecoveryPointer() { localStorage.removeItem(RECOVERY_KEY) }
function appendFinal(text) { if (!text) return; const last = segments[segments.length - 1]; if (!last || last.text !== text) segments.push({ id: crypto.randomUUID(), time: elapsed(), text }) }

function open() {
  modal.hidden = false
  document.body.classList.add('note-taker-open')
  $('noteTakerSetup').hidden = false
  $('noteTakerLive').hidden = true
  $('noteTakerComplete').hidden = true
  $('noteTakerMeetingTitle').focus()
  checkForRecovery()
}
function close() {
  if (['recording', 'paused', 'degraded', 'connecting'].includes(state)) {
    if (!confirm("You're still recording. Close anyway? Your note stays open in the background — nothing is lost.")) return
  }
  modal.hidden = true
  document.body.classList.remove('note-taker-open')
}

function checkForRecovery() {
  const raw = localStorage.getItem(RECOVERY_KEY)
  const banner = $('noteTakerRecoveryBanner')
  if (!raw || !banner) { if (banner) banner.hidden = true; return }
  let saved
  try { saved = JSON.parse(raw) } catch { clearRecoveryPointer(); banner.hidden = true; return }
  banner.hidden = false
  $('noteTakerRecoveryText').textContent = `We found an unfinished note ("${saved.title || 'Untitled meeting'}").`
  $('noteTakerRecoveryRestore').onclick = async () => {
    banner.hidden = true
    try {
      const session = await recoverNoteSession(saved.sessionId)
      sessionId = session.id; sessionVersion = session.version
      segments = session.transcript ? [{ id: crypto.randomUUID(), time: '00:00:00', text: session.transcript }] : []
      $('noteTakerMeetingTitle').value = session.title || ''
      $('noteTakerLanguage').value = session.language || 'en-NG'
      $('noteTakerSetup').hidden = true; $('noteTakerLive').hidden = false
      startedAt = Date.now(); pausedMs = 0
      render()
      await connectAndRecord()
    } catch (e) { clearRecoveryPointer(); setStatus('Could not restore that note', 'Starting a new one instead') }
  }
  $('noteTakerRecoveryDiscard').onclick = () => { clearRecoveryPointer(); banner.hidden = true }
}

// ---------- Audio level meter (visual only) ----------
function startLevelMeter() {
  audioCtx = new (window.AudioContext || window.webkitAudioContext)()
  sourceNode = audioCtx.createMediaStreamSource(stream)
  analyser = audioCtx.createAnalyser()
  sourceNode.connect(analyser)
  drawLevel()
}
function drawLevel() {
  if (!analyser || !['recording', 'degraded'].includes(state)) { $('noteTakerPulse')?.style.setProperty('--level', 0); return }
  const data = new Uint8Array(analyser.frequencyBinCount)
  analyser.getByteTimeDomainData(data)
  const level = data.reduce((sum, n) => sum + Math.abs(n - 128), 0) / data.length
  $('noteTakerPulse').style.setProperty('--level', Math.min(1, level / 32))
  raf = requestAnimationFrame(drawLevel)
}
function stopLevelMeter() {
  try { sourceNode?.disconnect() } catch {}
  try { audioCtx?.close() } catch {}
  cancelAnimationFrame(raf)
}

// ---------- Primary provider: the browser's own SpeechRecognition ----------
// Runs entirely on-device/in-browser with no server round trip, so it's
// free and effectively unlimited for us — but it does not exist at all on
// iOS (Safari, Chrome, or any other browser there, since Apple requires all
// iOS browsers to use WebKit, which never implemented this API). See
// startWhisperFallback() below for what covers that gap.
function startPrimarySpeech() {
  speechFailures = 0
  intentionalRecognitionStop = false
  recognition = new Speech()
  recognition.continuous = true
  recognition.interimResults = true
  // 'auto' has no true equivalent here (unlike a server model, the browser
  // can't detect-then-switch mid-stream) — leaving lang unset lets the
  // browser use its own default rather than silently mislabeling the
  // session as one specific language.
  const lang = $('noteTakerLanguage').value
  if (lang && lang !== 'auto') recognition.lang = lang
  recognition.onresult = (e) => {
    interim = ''
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const text = e.results[i][0].transcript.trim()
      if (e.results[i].isFinal) appendFinal(text)
      else interim += text + ' '
    }
    render()
  }
  recognition.onerror = (e) => {
    if (e.error === 'no-speech' || e.error === 'aborted') return // benign — onend below restarts it
    if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
      state = 'error'; setStatus('Microphone access is required', 'Enable microphone permission in your browser, then try again.')
      return
    }
    speechFailures++
    if (speechFailures >= MAX_SPEECH_FAILURES) startWhisperFallback()
  }
  recognition.onend = () => {
    if (intentionalRecognitionStop || state !== 'recording') return
    // Chrome/Edge stop the recognizer on their own periodically even with
    // continuous:true (silence, backgrounding, internal timeouts) — this is
    // expected and the standard fix is simply to restart it.
    try { recognition.start() } catch { speechFailures++; if (speechFailures >= MAX_SPEECH_FAILURES) startWhisperFallback() }
  }
  try {
    recognition.start()
    state = 'recording'
    setStatus('Recording', 'Live transcription active')
  } catch (e) {
    startWhisperFallback()
  }
}
function stopPrimarySpeech() {
  intentionalRecognitionStop = true
  try { recognition?.stop() } catch {}
  recognition = null
  clearTimeout(retryTimer)
}

// ---------- Fallback: free-tier Whisper, used only when the browser has no
// SpeechRecognition at all (chiefly iOS) or the primary keeps erroring ----------
function pickMimeType() {
  for (const t of MIME_CANDIDATES) { if (window.MediaRecorder?.isTypeSupported?.(t)) return t }
  return ''
}
// Each chunk is its own complete MediaRecorder session (start -> stop), so
// the resulting Blob is a standalone, independently-decodable audio file —
// a single long recording sliced with `timeslice` would produce WebM
// fragments Whisper can't decode on their own.
function recordOneChunk(ms) {
  return new Promise((resolve) => {
    if (!stream || !window.MediaRecorder) return resolve(null)
    const mimeType = pickMimeType()
    let rec
    try { rec = new MediaRecorder(stream, mimeType ? { mimeType } : undefined) } catch { return resolve(null) }
    const parts = []
    rec.ondataavailable = (e) => { if (e.data.size) parts.push(e.data) }
    rec.onstop = () => resolve(parts.length ? new Blob(parts, { type: mimeType || 'audio/webm' }) : null)
    rec.onerror = () => resolve(null)
    chunkRecorder = rec
    rec.start()
    setTimeout(() => { if (rec.state !== 'inactive') try { rec.stop() } catch {} }, ms)
  })
}
async function transcribeAndAppend(blob) {
  if (!blob || !sessionId) return
  try {
    const { text } = await transcribeChunk(sessionId, blob, $('noteTakerLanguage').value)
    if (text) { appendFinal(text); render(); persistNoteSegment(sessionId, { segmentId: crypto.randomUUID(), text, startMs: 0, endMs: 0 }).catch(() => {}) }
  } catch (e) { /* one missed chunk isn't fatal for the batch fallback; audio for it is simply gone */ }
}
async function runChunkLoop() {
  if (chunkLoopRunning) return
  chunkLoopRunning = true
  while (chunkLoopRunning && state === 'degraded') {
    const blob = await recordOneChunk(CHUNK_MS)
    if (!chunkLoopRunning || state !== 'degraded') break
    if (blob) chunkQueue = chunkQueue.then(() => transcribeAndAppend(blob)).catch(() => {})
  }
  chunkLoopRunning = false
}
function stopChunkLoop() {
  chunkLoopRunning = false
  try { if (chunkRecorder && chunkRecorder.state !== 'inactive') chunkRecorder.stop() } catch {}
}
function startWhisperFallback() {
  stopPrimarySpeech()
  state = 'degraded'
  setStatus(
    Speech ? 'Using backup transcription' : 'Recording',
    Speech ? "Live transcription hit a snag — we're retrying it in the background" : "Your browser doesn't support live speech recognition, so transcripts arrive every few seconds instead"
  )
  runChunkLoop()
  if (Speech) retryPrimaryInBackground() // only worth retrying if the browser *can* run it
}
function retryPrimaryInBackground() {
  clearTimeout(retryTimer)
  retryTimer = setTimeout(() => {
    if (state !== 'degraded') return
    stopChunkLoop()
    startPrimarySpeech()
  }, RETRY_PRIMARY_MS)
}

// ---------- Session lifecycle ----------
async function start() {
  if (!navigator.mediaDevices?.getUserMedia) return setStatus('Microphone unavailable', 'Use Cognita in a secure browser context (HTTPS).')
  state = 'requesting-permission'; setStatus('Requesting microphone', 'Allow microphone access to begin')
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } })
  } catch (e) {
    state = 'error'
    return setStatus('Microphone access is required', e.name === 'NotAllowedError' ? 'Enable microphone permission in your browser, then try again.' : 'No usable microphone was found.')
  }
  state = 'connecting'; setStatus('Starting Note Taker', 'Creating your session')
  let session
  try {
    session = await createNoteSession({ title: $('noteTakerMeetingTitle').value.trim(), language: $('noteTakerLanguage').value })
  } catch (e) {
    stream.getTracks().forEach((t) => t.stop())
    state = 'error'
    return setStatus('Could not start Note Taker', e.message || 'Please try again.')
  }
  sessionId = session.id; sessionVersion = session.version
  segments = []; interim = ''; pausedMs = 0; startedAt = Date.now()
  $('noteTakerSetup').hidden = true; $('noteTakerLive').hidden = false
  saveRecoveryPointer()
  timer = setInterval(() => $('noteTakerTimer').textContent = elapsed(), 250)
  startLevelMeter()
  await connectAndRecord()
}
async function connectAndRecord() {
  if (Speech) startPrimarySpeech()
  else { state = 'degraded'; setStatus('Recording', "Your browser doesn't support live speech recognition, so transcripts arrive every few seconds instead"); runChunkLoop() }
  autosaveTimer = setInterval(autosave, AUTOSAVE_MS)
}
async function autosave() {
  if (!sessionId || !['recording', 'paused', 'degraded'].includes(state)) return
  try {
    const res = await patchNoteSession(sessionId, { version: sessionVersion, transcript: segments.map((s) => s.text).join(' '), status: state === 'paused' ? 'paused' : 'recording', updatedAt: new Date().toISOString() })
    sessionVersion = res.version
  } catch (e) { if (e.session) sessionVersion = e.session.version }
}
function pause() {
  if (state === 'recording' || state === 'degraded') {
    const wasDegraded = state === 'degraded'
    state = 'paused'; pauseAt = Date.now()
    stream?.getTracks().forEach((t) => t.enabled = false)
    if (wasDegraded) stopChunkLoop(); else stopPrimarySpeech()
    clearTimeout(retryTimer)
    $('noteTakerPause').innerHTML = '<i class="ph ph-play"></i> Resume'
    setStatus('Paused', 'Audio capture is paused')
  } else if (state === 'paused') {
    pausedMs += Date.now() - pauseAt; pauseAt = 0
    stream?.getTracks().forEach((t) => t.enabled = true)
    $('noteTakerPause').innerHTML = '<i class="ph ph-pause"></i> Pause'
    if (Speech) startPrimarySpeech(); else { state = 'degraded'; setStatus('Recording', 'Resumed'); runChunkLoop() }
    drawLevel()
  }
}
function finish() { if (!segments.length && !interim) return stopNow(); if (confirm('Finish note? Your live transcript will be finalized.')) stopNow() }
async function stopNow() {
  state = 'stopping'; setStatus('Finalizing transcript', 'Wrapping up your note')
  clearInterval(timer); clearInterval(autosaveTimer); clearTimeout(retryTimer)
  stopPrimarySpeech()
  stopChunkLoop()
  await chunkQueue.catch(() => {}) // let any in-flight fallback transcription land before finalizing
  stopLevelMeter()
  stream?.getTracks().forEach((t) => t.stop())
  if (interim) { appendFinal(interim.trim()); interim = '' }
  const text = segments.map((s) => `[${s.time}] ${s.text}`).join('\n\n')
  if (sessionId) { try { await patchNoteSession(sessionId, { version: sessionVersion, transcript: segments.map((s) => s.text).join(' '), status: 'completed', updatedAt: new Date().toISOString() }) } catch {} }
  clearRecoveryPointer()
  state = 'completed'
  $('noteTakerEditor').value = text
  $('noteTakerCompleteTitle').textContent = $('noteTakerMeetingTitle').value.trim() || 'Meeting Notes'
  $('noteTakerMeta').textContent = `${new Date().toLocaleDateString()} · ${elapsed()} · ${$('noteTakerLanguage').selectedOptions[0].text}`
  $('noteTakerLive').hidden = true; $('noteTakerComplete').hidden = false
}

$('noteTakerStart').addEventListener('click', start)
$('noteTakerPause').addEventListener('click', pause)
$('noteTakerStop').addEventListener('click', finish)
$('noteTakerClose').addEventListener('click', close)
$('noteTakerCopy').addEventListener('click', async () => { await navigator.clipboard.writeText($('noteTakerEditor').value); $('noteTakerCopy').textContent = 'Copied' })
$('noteTakerDownload').addEventListener('click', () => { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([$('noteTakerEditor').value], { type: 'text/plain' })); a.download = `${$('noteTakerCompleteTitle').textContent || 'meeting-notes'}.txt`; a.click(); URL.revokeObjectURL(a.href) })
$('noteTakerEdit').addEventListener('click', () => $('noteTakerEditor').focus())
$('noteTakerAsk').addEventListener('click', () => { const input = $('composerInput'); input.value = `Please help me process these meeting notes:\n\n${$('noteTakerEditor').value}`; input.dispatchEvent(new Event('input', { bubbles: true })); close(); input.focus() })
window.addEventListener('cognita:open-note-taker', open)
window.addEventListener('online', () => { if (state === 'degraded' && Speech) { clearTimeout(retryTimer); retryTimer = setTimeout(retryPrimaryInBackground, 0) } })
window.addEventListener('offline', () => { if (state === 'recording' || state === 'degraded') setStatus('Offline', 'Audio is being preserved locally') })
window.addEventListener('beforeunload', (e) => { if (['recording', 'paused', 'degraded'].includes(state)) { e.preventDefault(); e.returnValue = '' } })
