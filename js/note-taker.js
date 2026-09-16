import { createNoteSession, patchNoteSession, persistNoteSegment, recoverNoteSession, openNoteStream } from './note-taker-production.js'

const $ = (id) => document.getElementById(id)
const modal = $('noteTakerModal')
const RECOVERY_KEY = 'cognitaNoteTakerSession'
const TARGET_SAMPLE_RATE = 16000
const MAX_WS_RETRIES = 5
const AUTOSAVE_MS = 20000

let stream, audioCtx, sourceNode, processorNode, recorder, recognition, analyser, raf, timer
let ws, wsRetries = 0, wsRetryTimer = null, intentionalClose = false
let autosaveTimer = null
let startedAt, pausedMs = 0, pauseAt
let segments = [], interim = ''
let state = 'idle' // idle | requesting-permission | connecting | recording | paused | reconnecting | degraded | stopping | completed | error
let sessionId = null, sessionVersion = 1
const Speech = window.SpeechRecognition || window.webkitSpeechRecognition

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
  if (['recording', 'paused', 'reconnecting', 'degraded', 'connecting'].includes(state)) {
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

// ---------- Audio capture + PCM16/16kHz encoding ----------
function resampleTo16k(float32, inputRate) {
  if (inputRate === TARGET_SAMPLE_RATE) return float32
  const ratio = inputRate / TARGET_SAMPLE_RATE
  const outLength = Math.round(float32.length / ratio)
  const out = new Float32Array(outLength)
  for (let i = 0; i < outLength; i++) {
    const srcIndex = i * ratio
    const i0 = Math.floor(srcIndex), i1 = Math.min(i0 + 1, float32.length - 1)
    const frac = srcIndex - i0
    out[i] = float32[i0] + (float32[i1] - float32[i0]) * frac
  }
  return out
}
function floatTo16BitPCM(float32) {
  const out = new Int16Array(float32.length)
  for (let i = 0; i < float32.length; i++) { const s = Math.max(-1, Math.min(1, float32[i])); out[i] = s < 0 ? s * 0x8000 : s * 0x7fff }
  return out
}
function startAudioGraph() {
  audioCtx = new (window.AudioContext || window.webkitAudioContext)()
  sourceNode = audioCtx.createMediaStreamSource(stream)
  analyser = audioCtx.createAnalyser()
  sourceNode.connect(analyser)
  // ScriptProcessorNode is deprecated but remains the most broadly
  // compatible way to get raw PCM frames (including on Safari/iOS) without
  // shipping a separate AudioWorklet module file.
  processorNode = audioCtx.createScriptProcessor(4096, 1, 1)
  sourceNode.connect(processorNode)
  processorNode.connect(audioCtx.createGain()) // keep the graph alive without audible output
  processorNode.onaudioprocess = (e) => {
    if (state !== 'recording') return
    if (!ws || ws.readyState !== WebSocket.OPEN) return
    const input = e.inputBuffer.getChannelData(0)
    const resampled = resampleTo16k(input, audioCtx.sampleRate)
    const pcm16 = floatTo16BitPCM(resampled)
    try { ws.send(pcm16.buffer) } catch {}
  }
  drawLevel()
}
function drawLevel() {
  if (!analyser || !['recording', 'reconnecting', 'degraded'].includes(state)) { $('noteTakerPulse')?.style.setProperty('--level', 0); return }
  const data = new Uint8Array(analyser.frequencyBinCount)
  analyser.getByteTimeDomainData(data)
  const level = data.reduce((sum, n) => sum + Math.abs(n - 128), 0) / data.length
  $('noteTakerPulse').style.setProperty('--level', Math.min(1, level / 32))
  raf = requestAnimationFrame(drawLevel)
}
function stopAudioGraph() {
  try { processorNode && (processorNode.onaudioprocess = null) } catch {}
  try { processorNode?.disconnect() } catch {}
  try { sourceNode?.disconnect() } catch {}
  try { audioCtx?.close() } catch {}
  cancelAnimationFrame(raf)
}

// ---------- Transcript reconciliation ----------
function handleTranscriptEvent(raw) {
  let msg
  try { msg = JSON.parse(raw) } catch { return }
  const alt = msg.channel?.alternatives?.[0]
  if (!alt) return
  const text = (alt.transcript || '').trim()
  if (msg.is_final) {
    interim = ''
    if (text) { const last = segments[segments.length - 1]; if (!last || last.text !== text) segments.push({ id: crypto.randomUUID(), time: elapsed(), text }); persistNoteSegment(sessionId, { segmentId: crypto.randomUUID(), text, startMs: 0, endMs: 0 }).catch(() => {}) }
  } else {
    interim = text
  }
  render()
}

// ---------- Primary provider: Cloudflare AI Gateway / Deepgram Nova-3 ----------
async function connectPrimary() {
  setStatus(wsRetries ? 'Reconnecting' : 'Connecting', wsRetries ? `Attempt ${wsRetries} of ${MAX_WS_RETRIES}` : 'Opening secure transcription connection')
  intentionalClose = false
  try {
    ws = await openNoteStream({ language: $('noteTakerLanguage').value, keywords: [] })
  } catch (e) { return scheduleReconnectOrFallback() }
  ws.addEventListener('open', () => { wsRetries = 0; state = 'recording'; setStatus('Recording', 'Live transcription active'); recognition?.stop() })
  ws.addEventListener('message', (e) => handleTranscriptEvent(e.data))
  ws.addEventListener('close', () => { if (!intentionalClose && ['recording', 'connecting', 'reconnecting'].includes(state)) scheduleReconnectOrFallback() })
  ws.addEventListener('error', () => {})
}
function scheduleReconnectOrFallback() {
  if (state === 'paused' || state === 'stopping' || state === 'completed') return
  if (wsRetries >= MAX_WS_RETRIES) { startFallback(); return }
  wsRetries++
  state = 'reconnecting'
  setStatus('Reconnecting', `Connection interrupted — retry ${wsRetries} of ${MAX_WS_RETRIES}`)
  const backoffMs = Math.min(16000, 1000 * 2 ** (wsRetries - 1))
  clearTimeout(wsRetryTimer)
  wsRetryTimer = setTimeout(connectPrimary, backoffMs)
}

// ---------- Fallback: browser SpeechRecognition, else local-only preservation ----------
function startFallback() {
  if (Speech) {
    state = 'degraded'
    setStatus('Using browser transcription', 'Live transcription switched to your browser')
    recognition = new Speech()
    recognition.continuous = true; recognition.interimResults = true
    recognition.lang = $('noteTakerLanguage').value === 'auto' ? 'en-NG' : $('noteTakerLanguage').value
    recognition.onresult = (e) => {
      interim = ''
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const text = e.results[i][0].transcript.trim()
        if (e.results[i].isFinal && text) { const last = segments[segments.length - 1]; if (!last || last.text !== text) segments.push({ id: crypto.randomUUID(), time: elapsed(), text }) }
        else interim += text + ' '
      }
      render()
    }
    recognition.onerror = () => {}
    recognition.onend = () => { if (state === 'degraded') try { recognition.start() } catch {} }
    recognition.start()
  } else {
    state = 'degraded'
    setStatus('Transcription paused — recording preserved', 'Your recording continues; live text is unavailable right now')
  }
  ensureLocalRecorder()
  retryPrimaryInBackground()
}
function ensureLocalRecorder() {
  if (recorder || !window.MediaRecorder) return
  try { recorder = new MediaRecorder(stream); recorder.start(4000) } catch {}
}
function retryPrimaryInBackground() {
  clearTimeout(wsRetryTimer)
  wsRetryTimer = setTimeout(async () => {
    if (state !== 'degraded') return
    try {
      const test = await openNoteStream({ language: $('noteTakerLanguage').value, keywords: [] })
      test.addEventListener('open', () => {
        recognition?.stop(); recognition = null
        try { recorder?.stop() } catch {}; recorder = null
        ws = test; wsRetries = 0; state = 'recording'
        setStatus('Recording', 'Live transcription active')
        ws.addEventListener('message', (e) => handleTranscriptEvent(e.data))
        ws.addEventListener('close', () => { if (!intentionalClose && ['recording', 'connecting', 'reconnecting'].includes(state)) scheduleReconnectOrFallback() })
      })
      test.addEventListener('error', () => { try { test.close() } catch {}; retryPrimaryInBackground() })
    } catch { retryPrimaryInBackground() }
  }, 30000)
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
  startAudioGraph()
  await connectAndRecord()
}
async function connectAndRecord() {
  wsRetries = 0
  await connectPrimary()
  autosaveTimer = setInterval(autosave, AUTOSAVE_MS)
}
async function autosave() {
  if (!sessionId || !['recording', 'paused', 'reconnecting', 'degraded'].includes(state)) return
  try {
    const res = await patchNoteSession(sessionId, { version: sessionVersion, transcript: segments.map((s) => s.text).join(' '), status: state === 'paused' ? 'paused' : 'recording', updatedAt: new Date().toISOString() })
    sessionVersion = res.version
  } catch (e) { if (e.session) sessionVersion = e.session.version }
}
function pause() {
  if (state === 'recording' || state === 'degraded') {
    state = 'paused'; pauseAt = Date.now()
    stream?.getTracks().forEach((t) => t.enabled = false)
    recognition?.stop()
    $('noteTakerPause').innerHTML = '<i class="ph ph-play"></i> Resume'
    setStatus('Paused', 'Audio capture is paused')
  } else if (state === 'paused') {
    pausedMs += Date.now() - pauseAt; pauseAt = 0
    stream?.getTracks().forEach((t) => t.enabled = true)
    state = ws && ws.readyState === WebSocket.OPEN ? 'recording' : 'degraded'
    if (recognition) try { recognition.start() } catch {}
    $('noteTakerPause').innerHTML = '<i class="ph ph-pause"></i> Pause'
    setStatus(state === 'recording' ? 'Recording' : 'Using browser transcription', 'Resumed')
    drawLevel()
  }
}
function finish() { if (!segments.length && !interim) return stopNow(); if (confirm('Finish note? Your live transcript will be finalized.')) stopNow() }
async function stopNow() {
  state = 'stopping'; setStatus('Finalizing transcript', 'Wrapping up your note')
  intentionalClose = true
  clearInterval(timer); clearInterval(autosaveTimer); clearTimeout(wsRetryTimer)
  recognition?.stop(); recognition = null
  try { recorder?.stop() } catch {}; recorder = null
  try { ws?.close() } catch {}
  stopAudioGraph()
  stream?.getTracks().forEach((t) => t.stop())
  if (interim) { segments.push({ id: crypto.randomUUID(), time: elapsed(), text: interim.trim() }); interim = '' }
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
window.addEventListener('online', () => { if (state === 'reconnecting' || state === 'degraded') { wsRetries = 0; connectPrimary() } })
window.addEventListener('offline', () => { if (['recording', 'reconnecting'].includes(state)) { state = 'reconnecting'; setStatus('Offline', 'Audio is being preserved locally'); ensureLocalRecorder() } })
window.addEventListener('beforeunload', (e) => { if (['recording', 'paused', 'reconnecting', 'degraded'].includes(state)) { e.preventDefault(); e.returnValue = '' } })
