import { createNoteSession, patchNoteSession, persistNoteSegment, recoverNoteSession, transcribeChunk, getNoteQuota, listSavedNotes, getSavedNote, saveNote, deleteSavedNote, summarizeNote } from './note-taker-production.js'

const $ = (id) => document.getElementById(id)
const modal = $('noteTakerModal')
const RECOVERY_KEY = 'cognitaNoteTakerSession'
const AUTOSAVE_PREF_KEY = 'cognitaNoteTakerSaveOnFinish'
const MIN_SUMMARY_CHARS = 200 // matches saved-notes-endpoint.js
const AUTOSAVE_MS = 20000
const QUOTA_NOTICE_KEY = 'cognitaNoteQuotaNotice'
const LIST_COUNT_KEY = 'cognitaNoteListCount' // last known number of saved notes, so the loading skeleton has the right number of rows
const AGENDA_LABEL = { covered: 'Covered', partial: 'Partly covered', not_covered: 'Not covered' }
const QUOTA_WARN_AT = 0.9        // show the "nearly used up" notice from 90% of today's cloud allowance
const QUOTA_STALE_MS = 15000     // how old the mirrored allowance may be before it is fetched again
const RETRY_PRIMARY_MS = 30000
const MAX_SPEECH_FAILURES = 3
const CHUNK_MIN_MS = 6000       // earliest a cloud chunk may close, and only on a pause in speech
const CHUNK_MAX_MS = 14000      // hard ceiling so a non-stop speaker still gets transcribed
const SILENCE_MS = 650
const VOICED_LEVEL = 3          // mean deviation from 128 on the analyser; below this counts as silence
const MIME_CANDIDATES = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus']
const Speech = window.SpeechRecognition || window.webkitSpeechRecognition

// Which engine leads for each language. The browser recognizer is free and
// streams word by word, but has no Yoruba, Hausa or Pidgin model, so those go
// straight to Whisper instead of being mis-transcribed as English.
const LANGS = {
  'en-NG': { browser: 'en-NG', fallback: 'en-GB' }, // Vertex finding: en-NG is missing on some Chrome builds
  'en-GB': { browser: 'en-GB' }, 'en-US': { browser: 'en-US' }, 'fr-FR': { browser: 'fr-FR' },
  'pcm-NG': { browser: null }, 'yo-NG': { browser: null }, 'ha-NG': { browser: null }, auto: { browser: null },
}
// Nigerian names/places the recognizer often splits or mis-spells. Used to
// rerank the browser's alternative transcripts (the Vertex n-best approach).
const NG_LEXICON = /\b(lagos|abuja|ibadan|kano|enugu|port harcourt|naira|jamb|waec|neco|nnpc|oga|abeg|wahala|adebayo|chukwu\w*|ibrahim|ngozi|olu\w*|ade\w*|emeka|tunde|bola|femi|yoruba|igbo|hausa)\b/gi
const HALLUCINATIONS = /^(thank you\.?|thanks for watching\.?|thanks\.?|you\.?|bye\.?|\.+)$/i

let stream, analyser, audioCtx, sourceNode, raf, timer, autosaveTimer, retryTimer
let chunkRecorder = null, chunkLoopRunning = false, chunkQueue = Promise.resolve()
let recognition, speechFailures = 0, intentionalStop = false, langOverride = null, restartTimer = null, freeOnly = false
// Cloud (Whisper) allowance as the server last reported it. Null until loaded; while null the cloud is treated as
// available and the server decides. inflightSec is audio already sent but not yet counted in `quota`.
let quota = null, quotaFetchedAt = 0, quotaPromise = null, inflightSec = 0, cloudBase = '', exhaustHandled = false
let noticePriority = 0
let startedAt, pausedMs = 0, pauseAt = 0, finishArmed = null, opener = null
let segments = [], interim = ''
let state = 'idle' // idle | requesting-permission | connecting | recording | paused | degraded | stopping | completed | error
let sessionId = null, sessionVersion = 1
// The note on screen after recording, or opened from Saved notes. Null until then.
// { id, createdAt, durationMs, language, agenda, summary, saved, dirty }
let draft = null, editVersion = 0, saving = false, summarizing = false
let savedNotes = null, savedLimit = null, savedLoading = false, savedFailed = false, searchTerm = ''
let deleteArmed = null, newArmed = null, discardArmedId = null, view = 'transcript', lastGroup = ''

const ACTIVE = ['recording', 'paused', 'degraded', 'connecting']
const isActive = () => ACTIVE.includes(state)
const langCode = () => $('noteTakerLanguage').value
const browserLang = () => (Speech && LANGS[langCode()]?.browser) || null

function formatTime(ms) { const s = Math.max(0, Math.floor(ms / 1000)); return [Math.floor(s / 3600), Math.floor(s / 60) % 60, s % 60].map((n) => String(n).padStart(2, '0')).join(':') }
function elapsedMs() { return startedAt ? Date.now() - startedAt - pausedMs - (pauseAt ? Date.now() - pauseAt : 0) : 0 }
function elapsed() { return formatTime(elapsedMs()) }
function escapeHtml(v) { return v.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])) }
function setState(next) { state = next; $('noteTakerLive').dataset.state = next; $('noteTakerChip').dataset.state = next }
function setStatus(text, detail = '') { $('noteTakerStatus').textContent = text; $('noteTakerConnection').textContent = detail }
// Errors before the live view exists must show in the setup view, otherwise they render into a hidden panel.
function showSetupError(text) { const el = $('noteTakerSetupError'); el.textContent = text; el.hidden = !text }
function show(view) {
  for (const v of ['Setup', 'Live', 'Complete', 'Saved']) $(`noteTaker${v}`).hidden = v.toLowerCase() !== view
  $('noteTakerTabs').hidden = view === 'live' // the recording screen has no room for tabs
  const onSaved = view === 'saved'
  $('noteTakerTabSaved').setAttribute('aria-selected', String(onSaved))
  $('noteTakerTabRecord').setAttribute('aria-selected', String(!onSaved))
  if (view !== 'setup') $('noteTakerRecoveryBanner').hidden = true
  if (view === 'complete' || view === 'saved') hideNotice() // allowance notices belong to recording, not to reading notes
}

function render() {
  const root = $('noteTakerTranscript')
  const rows = segments.map((s) => `<p class="note-segment"><time>${s.time}</time><span>${escapeHtml(s.text)}</span></p>`)
  if (interim) rows.push(`<p class="note-segment interim"><time></time><span>${escapeHtml(interim)}</span></p>`)
  if (!rows.length) {
    const cloud = !browserLang()
    root.innerHTML = `<p class="note-taker-empty">${cloud ? 'Speak as normal. Text appears after each pause, usually within a few seconds.' : 'Start speaking and the transcript will appear here.'}</p>`
    return
  }
  const nearBottom = root.scrollHeight - root.scrollTop - root.clientHeight < 80
  root.innerHTML = rows.join('')
  if (nearBottom) root.scrollTop = root.scrollHeight // don't yank the view while someone is reading back
}
function saveRecoveryPointer() { if (sessionId) try { localStorage.setItem(RECOVERY_KEY, JSON.stringify({ sessionId, version: sessionVersion, title: $('noteTakerMeetingTitle').value.trim(), language: langCode(), startedAt })) } catch {} }
function clearRecoveryPointer() { try { localStorage.removeItem(RECOVERY_KEY) } catch {} }
function appendFinal(text) {
  text = (text || '').trim()
  if (!text) return
  const last = segments[segments.length - 1]
  if (last && last.text === text) return
  const seg = { id: crypto.randomUUID(), time: elapsed(), text }
  segments.push(seg)
  if (sessionId) persistNoteSegment(sessionId, { segmentId: seg.id, text, startMs: elapsedMs(), endMs: elapsedMs() }).catch(() => {})
}

// ---------- Cloud transcription allowance ----------
// The Worker counts and enforces the daily Whisper allowance (note-taker-endpoint.js). This only mirrors what it
// reports so the person is warned early and the recorder can hand over to the free browser engine BEFORE a chunk is
// refused. Browser recognition is free and never counted. If the allowance cannot be loaded, cloud is assumed
// available and the server remains the authority.
function fmtSpan(sec, floor = false) {
  sec = Math.max(0, sec)
  if (sec >= 3600) { const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60); return m ? `${h} h ${m} min` : `${h} h` }
  const m = floor ? Math.floor(sec / 60) : Math.round(sec / 60)
  return `${m} min`
}
const fmtLeft = (sec) => (sec > 0 && sec < 60 ? 'less than a minute' : fmtSpan(sec, true))
function fmtUsed(q) { return q.limitSeconds < 3600 ? `${Math.round(q.usedSeconds / 60)} of ${Math.round(q.limitSeconds / 60)} min` : `${fmtSpan(q.usedSeconds)} of ${fmtSpan(q.limitSeconds)}` }
const resetTime = () => { const d = quota?.resetsAt ? new Date(quota.resetsAt) : null; return d && !isNaN(d) ? d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : 'tomorrow' }

function cloudRemaining() {
  if (!quota || quota.unlimited) return Infinity
  if (quota.resetsAt && Date.now() >= Date.parse(quota.resetsAt)) { if (Date.now() - quotaFetchedAt > 5000) refreshQuota(true); return Infinity } // a new day has begun; the server confirms
  return Math.max(0, quota.remainingSeconds ?? quota.limitSeconds - quota.usedSeconds)
}
const cloudAvailable = (reserve = 0) => cloudRemaining() - reserve > 0

function refreshQuota(force = false) {
  if (quotaPromise) return quotaPromise
  if (!force && Date.now() - quotaFetchedAt < QUOTA_STALE_MS) return Promise.resolve(quota)
  quotaPromise = getNoteQuota().then(applyQuota).catch(() => {}).then(() => { quotaFetchedAt = Date.now(); quotaPromise = null; return quota })
  return quotaPromise
}
function noticeSeen(q) { try { const v = JSON.parse(localStorage.getItem(QUOTA_NOTICE_KEY) || 'null'); return v && v.reset === q.resetsAt ? v.level : 0 } catch { return 0 } }
function markNoticeSeen(q, level) { try { localStorage.setItem(QUOTA_NOTICE_KEY, JSON.stringify({ reset: q.resetsAt, level })) } catch {} }

function applyQuota(q) {
  if (!q) return
  quota = q; quotaFetchedAt = Date.now()
  renderQuota()
  if (state === 'degraded' && cloudBase) setStatus('Recording', cloudDetail())
  if (q.unlimited) return
  // Each threshold is announced once per day, so opening the panel again does not repeat it.
  const ratio = q.usedSeconds / q.limitSeconds
  const level = ratio >= 1 ? 100 : ratio >= QUOTA_WARN_AT ? 90 : 0
  if (level && noticeSeen(q) < level) { markNoticeSeen(q, level); showQuotaNotice(level === 100 ? 'full' : 'warn') }
}
function cloudDetail() {
  if (!quota || quota.unlimited) return cloudBase
  const left = cloudRemaining() - inflightSec
  return left > 0 ? `${cloudBase} ${fmtLeft(left)} left today.` : cloudBase
}
function renderQuota() {
  const box = $('noteTakerQuota'); const q = quota
  const show = !!q && !q.unlimited && (q.usedSeconds > 0 || !browserLang())
  box.hidden = !show
  if (!show) return
  const ratio = Math.min(1, q.usedSeconds / q.limitSeconds)
  box.dataset.level = ratio >= 1 ? 'full' : ratio >= QUOTA_WARN_AT ? 'warning' : 'ok'
  $('noteTakerQuotaValue').textContent = ratio >= 1 ? 'Used up' : `${fmtLeft(q.remainingSeconds)} left`
  $('noteTakerQuotaBar').firstElementChild.style.width = `${ratio * 100}%`
  $('noteTakerQuotaBar').setAttribute('aria-valuenow', String(Math.round(ratio * 100)))
  $('noteTakerQuotaHint').textContent = browserLang()
    ? `Only used if live recognition falls back to the cloud. Resets at ${resetTime()}.`
    : `${langLabel(langCode()) || 'This language'} uses cloud transcription. Resets at ${resetTime()}.`
}

// ----- Notices -----
const NOTICE_RANK = { warn: 1, full: 2, switched: 3, paused: 4, blocked: 4 }
function hideNotice() { $('noteTakerNotice').hidden = true; noticePriority = 0; $('noteTakerChip').dataset.alert = 'false' }
function showNotice(kind, tone, text, actions = []) {
  if (NOTICE_RANK[kind] < noticePriority) return // a warning must never replace "recording is paused"
  noticePriority = NOTICE_RANK[kind]
  const box = $('noteTakerNotice'); box.dataset.tone = tone
  $('noteTakerNoticeText').textContent = text
  const holder = $('noteTakerNoticeActions'); holder.replaceChildren()
  for (const a of [...actions, { label: 'Dismiss', ghost: true, onClick: hideNotice }]) {
    const el = document.createElement(a.href ? 'a' : 'button')
    el.className = a.ghost ? 'note-taker-ghost' : a.primary ? 'note-taker-primary' : 'note-taker-secondary'
    el.textContent = a.label
    if (a.href) el.href = a.href; else { el.type = 'button'; el.addEventListener('click', a.onClick) }
    holder.appendChild(el)
  }
  box.hidden = false
  $('noteTakerChip').dataset.alert = String(modal.hidden) // minimized: mark the chip so the notice is not missed
}
function upgradeAction() { const u = quota?.upgrade; return u ? [{ label: `See ${u.name}`, href: '/pricing.html' }] : [] }
function showQuotaNotice(kind) {
  const q = quota; if (!q) return
  const reset = resetTime(), u = q.upgrade
  const more = u ? ` ${u.name} includes ${fmtSpan(u.limitSeconds)} a day.` : ''
  const lang = langLabel(langCode()) || 'this language'
  if (kind === 'warn') return showNotice(kind, 'warning', `You have used ${fmtUsed(q)} of today's cloud transcription. Live recognition in your browser does not count toward this. It resets at ${reset}.${more}`, upgradeAction())
  if (kind === 'full') return showNotice(kind, 'limit', `Today's cloud transcription is used up. Live recognition in your browser is still free. It resets at ${reset}.${more}`, upgradeAction())
  if (kind === 'switched') return showNotice(kind, 'limit', `Today's cloud transcription is used up, so recording continues with your browser's free live recognition. It resets at ${reset}.${more}`, upgradeAction())
  // 'paused' (mid-recording) and 'blocked' (before starting): this language has no free engine
  if (!Speech) return showNotice(kind, 'limit', `Today's cloud transcription is used up, and this browser has no free live recognition. Recording is available again after ${reset}.${more}`, upgradeAction())
  const go = kind === 'paused' ? continueInEnglish : startInEnglish
  showNotice(kind, 'limit', `Today's cloud transcription is used up, and ${lang} needs it. You can continue in English with free live recognition, or come back after ${reset}.${more}`,
    [{ label: kind === 'paused' ? 'Continue in English' : 'Record in English', primary: true, onClick: go }, ...upgradeAction()])
}

// Cloud-only languages (no browser model) cannot record without allowance. A language the browser handles
// never needs to ask: it just carries on with the free engine.
async function gateCloud() {
  if (browserLang()) return true
  if (quota && !cloudAvailable()) await refreshQuota(true) // an upgrade or a new day may have changed it
  if (cloudAvailable()) return true
  showQuotaNotice('blocked'); renderQuota()
  return false
}
function switchToEnglish() { $('noteTakerLanguage').value = 'en-NG'; updateLanguageHint(); hideNotice() }
function startInEnglish() { switchToEnglish(); start() }
function continueInEnglish() { switchToEnglish(); if (state === 'paused') resumeCapture() }
// Allowance ran out mid-recording. A language with a free engine switches to it seamlessly; otherwise the note pauses.
function handleQuotaExhausted() {
  if (exhaustHandled || !['degraded', 'recording'].includes(state)) return
  exhaustHandled = true
  stopChunkLoop(); clearTimeout(retryTimer)
  if (browserLang()) { showQuotaNotice('switched'); startPrimarySpeech(); return }
  pause()
  showQuotaNotice('paused')
}

// ---------- Open / minimize / close ----------
function open() {
  opener = document.activeElement
  modal.hidden = false
  $('noteTakerChip').hidden = true
  document.body.classList.add('note-taker-open')
  $('noteTakerChip').dataset.alert = 'false'
  refreshQuota()
  if (isActive()) { show('live'); render(); return $('noteTakerPause').focus() }
  if (draft && $('noteTakerEditor').value) { show('complete'); return $('noteTakerEditor').focus() }
  resetSetup()
  checkForRecovery()
  $('noteTakerMeetingTitle').focus()
}
function resetSetup() {
  show('setup'); showSetupError('')
  $('noteTakerPause').innerHTML = '<i class="ph ph-pause"></i> Pause'
  $('noteTakerStop').innerHTML = '<i class="ph ph-stop"></i> Finish'
  $('noteTakerCopy').innerHTML = '<i class="ph ph-copy"></i> Copy'
  updateLanguageHint()
  try { $('noteTakerAutoSave').checked = localStorage.getItem(AUTOSAVE_PREF_KEY) === '1' } catch {}
}
// Closing during a recording minimizes it. The old confirm() promised the note "stays open in the
// background", but reopening showed the setup form with no way back to the live session.
function close() {
  modal.hidden = true
  document.body.classList.remove('note-taker-open')
  if (isActive()) { $('noteTakerChip').hidden = false; $('noteTakerChipTime').textContent = elapsed() }
  else if (state === 'stopping') $('noteTakerChip').hidden = true
  opener?.focus?.()
}
function updateLanguageHint() {
  const l = LANGS[langCode()]
  const yoruba = ['yo-NG', 'ha-NG', 'pcm-NG'].includes(langCode())
  $('noteTakerLanguageHint').textContent = yoruba
    ? 'Transcribed in the cloud, so text arrives after each pause rather than word by word. Accuracy for this language is still limited; check names and numbers.'
    : !Speech && l?.browser !== undefined ? 'Your browser has no live recognition, so text arrives after each pause.'
    : l?.browser ? 'Words appear live as people speak.' : 'Language is detected automatically. Text arrives after each pause.'
  renderQuota()
}

function checkForRecovery() {
  const banner = $('noteTakerRecoveryBanner')
  let saved
  try { saved = JSON.parse(localStorage.getItem(RECOVERY_KEY) || 'null') } catch { clearRecoveryPointer() }
  if (!saved) { banner.hidden = true; return }
  banner.hidden = false
  $('noteTakerRecoveryText').textContent = `Unfinished note found: "${saved.title || 'Untitled meeting'}"`
  $('noteTakerRecoveryRestore').onclick = async () => {
    banner.hidden = true
    try {
      const session = await recoverNoteSession(saved.sessionId)
      sessionId = session.id; sessionVersion = session.version
      segments = session.transcript ? [{ id: crypto.randomUUID(), time: '00:00:00', text: session.transcript }] : []
      $('noteTakerMeetingTitle').value = session.title || ''
      $('noteTakerLanguage').value = LANGS[session.language] ? session.language : 'en-NG'
      // Recovery used to skip the mic, timer and level meter entirely, so the restored note recorded nothing.
      if (await beginCapture()) saveRecoveryPointer(); else if (!isActive()) banner.hidden = false // blocked (e.g. allowance used up): the unfinished note stays restorable
    } catch { clearRecoveryPointer(); showSetupError("That note couldn't be restored. You can start a new one below.") }
  }
  $('noteTakerRecoveryDiscard').onclick = () => { clearRecoveryPointer(); banner.hidden = true }
}

// ---------- Audio level + silence detection ----------
function currentLevel() {
  if (!analyser) return 0
  const data = new Uint8Array(analyser.fftSize)
  analyser.getByteTimeDomainData(data)
  return data.reduce((sum, n) => sum + Math.abs(n - 128), 0) / data.length
}
function startLevelMeter() {
  audioCtx = new (window.AudioContext || window.webkitAudioContext)()
  audioCtx.resume?.() // iOS starts contexts suspended
  sourceNode = audioCtx.createMediaStreamSource(stream)
  analyser = audioCtx.createAnalyser()
  sourceNode.connect(analyser)
  drawLevel()
}
function drawLevel() {
  cancelAnimationFrame(raf)
  if (!analyser || !['recording', 'degraded'].includes(state)) { $('noteTakerPulse').style.setProperty('--level', 0); return }
  $('noteTakerPulse').style.setProperty('--level', Math.min(1, currentLevel() / 32))
  raf = requestAnimationFrame(drawLevel)
}
function stopLevelMeter() {
  cancelAnimationFrame(raf)
  try { sourceNode?.disconnect() } catch {}
  try { audioCtx?.close() } catch {}
  analyser = null
}

// ---------- Primary: the browser's SpeechRecognition ----------
// Vertex lessons applied: en-NG with maxAlternatives, fall back to en-GB when the locale is
// rejected, and rerank alternatives against a Nigerian lexicon.
function bestAlternative(result) {
  let best = null, bestScore = -1
  for (let a = 0; a < result.length; a++) {
    const { transcript, confidence } = result[a]
    const score = (confidence || (a === 0 ? 0.5 : 0)) + Math.min(3, (transcript.match(NG_LEXICON) || []).length) * 0.08
    if (score > bestScore) { best = transcript; bestScore = score }
  }
  return (best || '').trim()
}
function startPrimarySpeech() {
  intentionalStop = false
  recognition = new Speech()
  recognition.continuous = true
  recognition.interimResults = true
  recognition.maxAlternatives = 5
  recognition.lang = langOverride || browserLang()
  recognition.onresult = (e) => {
    speechFailures = 0 // a working session must not accumulate old errors toward the fallback
    freeOnly = false
    interim = ''
    for (let i = e.resultIndex; i < e.results.length; i++) {
      if (e.results[i].isFinal) appendFinal(bestAlternative(e.results[i]))
      else interim += e.results[i][0].transcript.trim() + ' '
    }
    render()
  }
  recognition.onerror = (e) => {
    if (e.error === 'no-speech' || e.error === 'aborted') return
    if (e.error === 'language-not-supported' && LANGS[langCode()]?.fallback && langOverride !== LANGS[langCode()].fallback) {
      langOverride = LANGS[langCode()].fallback; return // onend restarts with the fallback locale
    }
    if (e.error === 'not-allowed' || e.error === 'service-not-allowed') { fatalMicError(); return }
    if (++speechFailures >= MAX_SPEECH_FAILURES) startWhisperFallback()
  }
  recognition.onend = () => {
    if (interim.trim()) { appendFinal(interim); interim = ''; render() } // don't lose words the recognizer never finalized
    if (intentionalStop || state !== 'recording') return
    restartPrimary(freeOnly ? 2000 : 0) // with no cloud to fall back on, pace the retries instead of spinning
  }
  try { recognition.start(); setState('recording'); setStatus('Recording', freeOnly ? 'Live transcription. Cloud transcription is used up for today.' : 'Live transcription') }
  catch { startWhisperFallback(); if (state === 'recording') restartPrimary(2000) }
}
function restartPrimary(delay) {
  clearTimeout(restartTimer)
  const go = () => {
    if (intentionalStop || state !== 'recording') return
    try { startPrimarySpeech() }
    catch { if (++speechFailures >= MAX_SPEECH_FAILURES) startWhisperFallback(); if (state === 'recording') restartPrimary(2000) }
  }
  if (delay) restartTimer = setTimeout(go, delay); else go()
}
function stopPrimarySpeech() {
  intentionalStop = true
  const r = recognition; recognition = null
  try { r?.stop() } catch {}
  clearTimeout(retryTimer); clearTimeout(restartTimer)
}
function fatalMicError() {
  setState('error'); stopPrimarySpeech(); stopChunkLoop()
  setStatus('Microphone blocked', 'Allow microphone access in your browser settings, then resume.')
}

// ---------- Cloud transcription (Whisper large-v3-turbo) ----------
function pickMimeType() { for (const t of MIME_CANDIDATES) if (window.MediaRecorder?.isTypeSupported?.(t)) return t; return '' }
// Each chunk is a complete MediaRecorder session so the Blob decodes on its own. A chunk closes on a
// pause in speech (after CHUNK_MIN_MS) instead of a fixed 8s cut, so words are no longer sliced in half.
// Chunks with no speech resolve null: no wasted quota, no Whisper "Thank you" hallucinations on silence.
function recordOneChunk() {
  return new Promise((resolve) => {
    if (!stream || !window.MediaRecorder) return resolve(null)
    const mimeType = pickMimeType()
    let rec
    try { rec = new MediaRecorder(stream, mimeType ? { mimeType } : undefined) } catch { return resolve(null) }
    const parts = []
    let voiced = false, silentSince = 0
    const t0 = Date.now()
    const poll = setInterval(() => {
      const age = Date.now() - t0
      if (currentLevel() > VOICED_LEVEL) { voiced = true; silentSince = 0 } else if (!silentSince) silentSince = Date.now()
      const paused = voiced && silentSince && Date.now() - silentSince > SILENCE_MS
      if (rec.state !== 'inactive' && ((age >= CHUNK_MIN_MS && paused) || age >= CHUNK_MAX_MS || (!voiced && age >= CHUNK_MIN_MS) || !chunkLoopRunning)) try { rec.stop() } catch {}
    }, 100)
    rec.ondataavailable = (e) => { if (e.data.size) parts.push(e.data) }
    rec.onstop = () => { clearInterval(poll); resolve(voiced && parts.length ? { blob: new Blob(parts, { type: mimeType || 'audio/webm' }), ms: Date.now() - t0 } : null) }
    rec.onerror = () => { clearInterval(poll); resolve(null) }
    chunkRecorder = rec
    rec.start()
  })
}
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function transcribeAndAppend({ blob, ms }) {
  const sec = Math.ceil(ms / 1000)
  const settle = () => { inflightSec = Math.max(0, inflightSec - sec) } // once answered, the audio is in the server's count (or was never charged)
  if (!sessionId) return settle()
  const context = segments.slice(-3).map((s) => s.text).join(' ') // recent words steer spelling and continuity
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await transcribeChunk(sessionId, blob, langCode(), context, ms)
      settle()
      if (res.quota) applyQuota(res.quota)
      const text = (res.text || '').trim()
      if (text && !HALLUCINATIONS.test(text)) { appendFinal(text); render() }
      return
    } catch (e) {
      if (e.quota) applyQuota(e.quota)
      if (e.code === 'WHISPER_QUOTA_EXHAUSTED') { settle(); return handleQuotaExhausted() }
      // Network drops and 5xx are usually momentary: one retry, so a hiccup does not silently lose a few seconds of speech.
      if ((e.offline || e.status >= 500) && attempt < 1 && isActive()) { await wait(1500); continue }
      settle()
      return reportChunkFailure(e)
    }
  }
}
function reportChunkFailure(e) {
  if (!isActive()) return
  if (e.status === 401 || e.status === 403) return setStatus('Signed out', 'Sign in again to keep transcribing. The text so far is safe.')
  if (e.code === 'PROVIDER_BUSY') return setStatus('Recording', 'Cloud transcription is busy. Some speech was missed. This did not use your allowance.')
  setStatus('Recording', e.offline ? 'Offline. Some speech could not be transcribed.' : 'Some speech could not be transcribed.')
}
async function runChunkLoop() {
  if (chunkLoopRunning) return
  chunkLoopRunning = true
  while (chunkLoopRunning && state === 'degraded') {
    // Audio already sent counts against the allowance too, so hand over before recording a chunk that would be refused.
    if (!cloudAvailable(inflightSec)) { chunkLoopRunning = false; handleQuotaExhausted(); break }
    const chunk = await recordOneChunk()
    if (!chunk) continue
    if (chunkLoopRunning && !cloudAvailable(inflightSec)) { chunkLoopRunning = false; handleQuotaExhausted(); break } // another device used the rest while this was recording
    inflightSec += Math.ceil(chunk.ms / 1000)
    chunkQueue = chunkQueue.then(() => transcribeAndAppend(chunk)).catch(() => {})
  }
  chunkLoopRunning = false
}
function stopChunkLoop() { chunkLoopRunning = false; try { if (chunkRecorder?.state !== 'inactive') chunkRecorder?.stop() } catch {} }
function startCloudMode(reason) {
  stopPrimarySpeech()
  exhaustHandled = false; cloudBase = reason
  setState('degraded')
  setStatus('Recording', cloudDetail())
  render()
  runChunkLoop()
}
function startWhisperFallback() {
  // Cloud is the fallback for a flaky browser engine. With today's allowance gone there is nothing to fall back to,
  // so keep retrying the free engine rather than leaving the note silent.
  if (!cloudAvailable(inflightSec)) {
    freeOnly = true; speechFailures = 0
    if (state === 'recording') setStatus('Recording', 'Live recognition hit a problem and is retrying. Cloud transcription is used up for today.')
    return
  }
  startCloudMode('Live recognition hit a problem. Text now arrives after each pause.')
  if (browserLang()) { clearTimeout(retryTimer); retryTimer = setTimeout(() => { if (state === 'degraded') { stopChunkLoop(); startPrimarySpeech() } }, RETRY_PRIMARY_MS) }
}

// ---------- Session lifecycle ----------
async function acquireMic() {
  if (!navigator.mediaDevices?.getUserMedia) { showSetupError('The microphone needs a secure (HTTPS) connection.'); return false }
  setState('requesting-permission')
  $('noteTakerStart').disabled = true
  try { stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } }); return true }
  catch (e) {
    setState('error'); $('noteTakerStart').disabled = false
    showSetupError(e.name === 'NotAllowedError' ? 'Microphone access is blocked. Allow it in your browser settings, then try again.' : 'No microphone was found. Connect one and try again.')
    return false
  }
}
async function beginCapture() {
  if (!(await gateCloud())) return false
  if (!stream && !(await acquireMic())) return false
  show('live'); setState('connecting'); setStatus('Starting', ''); segments = segments || []; interim = ''
  pausedMs = 0; pauseAt = 0; startedAt = Date.now(); langOverride = null; freeOnly = false; inflightSec = 0; render()
  clearInterval(timer)
  timer = setInterval(() => { const t = elapsed(); $('noteTakerTimer').textContent = t; $('noteTakerChipTime').textContent = t }, 250)
  startLevelMeter()
  if (browserLang()) startPrimarySpeech()
  else startCloudMode(['yo-NG', 'ha-NG', 'pcm-NG', 'auto'].includes(langCode()) ? 'Cloud transcription. Text arrives after each pause.' : 'Your browser has no live recognition. Text arrives after each pause.')
  clearInterval(autosaveTimer); autosaveTimer = setInterval(autosave, AUTOSAVE_MS)
  return true
}
async function start() {
  showSetupError('')
  if (!(await gateCloud())) return // before the mic and before a session is created, so a blocked start costs nothing
  if (!(await acquireMic())) return
  setState('connecting')
  let session
  try { session = await createNoteSession({ title: $('noteTakerMeetingTitle').value.trim(), language: langCode() }) }
  catch (e) {
    stream.getTracks().forEach((t) => t.stop()); stream = null
    setState('error'); $('noteTakerStart').disabled = false
    return showSetupError(e.message || 'Could not start the note. Check your connection and try again.')
  }
  sessionId = session.id; sessionVersion = session.version; segments = []
  $('noteTakerStart').disabled = false
  if (await beginCapture()) saveRecoveryPointer()
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
    const cloud = state === 'degraded'
    setState('paused'); pauseAt = Date.now()
    stream?.getTracks().forEach((t) => (t.enabled = false))
    if (cloud) stopChunkLoop(); else stopPrimarySpeech()
    clearTimeout(retryTimer); drawLevel()
    $('noteTakerPause').innerHTML = '<i class="ph ph-play"></i> Resume'
    setStatus('Paused', 'Nothing is being recorded')
  } else if (state === 'paused' || state === 'error') {
    resumeCapture()
  }
}
async function resumeCapture() {
  // A cloud-only language cannot resume without allowance (it may have reset or been upgraded since).
  if (!(await gateCloud())) return
  if (pauseAt) { pausedMs += Date.now() - pauseAt; pauseAt = 0 }
  stream?.getTracks().forEach((t) => (t.enabled = true))
  $('noteTakerPause').innerHTML = '<i class="ph ph-pause"></i> Pause'
  hideNotice()
  if (browserLang()) startPrimarySpeech(); else startCloudMode('Cloud transcription. Text arrives after each pause.')
  drawLevel()
}
function finish() {
  if (!segments.length && !interim) return stopNow()
  const btn = $('noteTakerStop')
  if (finishArmed) { clearTimeout(finishArmed); finishArmed = null; return stopNow() }
  btn.textContent = 'Tap again to finish'
  finishArmed = setTimeout(() => { finishArmed = null; btn.innerHTML = '<i class="ph ph-stop"></i> Finish' }, 3500)
}
async function stopNow() {
  setState('stopping'); setStatus('Finishing', 'Adding the last words')
  clearInterval(timer); clearInterval(autosaveTimer); clearTimeout(retryTimer)
  stopPrimarySpeech(); stopChunkLoop()
  await chunkQueue.catch(() => {})
  inflightSec = 0; exhaustHandled = false; hideNotice()
  stopLevelMeter()
  stream?.getTracks().forEach((t) => t.stop()); stream = null
  if (interim.trim()) { appendFinal(interim); interim = '' }
  const text = segments.map((s) => `[${s.time}] ${s.text}`).join('\n\n')
  if (sessionId) { try { await patchNoteSession(sessionId, { version: sessionVersion, transcript: segments.map((s) => s.text).join(' '), status: 'completed', updatedAt: new Date().toISOString() }) } catch {} }
  clearRecoveryPointer()
  setState('completed')
  draft = {
    id: sessionId || crypto.randomUUID().replaceAll('-', ''),
    createdAt: new Date(startedAt).toISOString(), durationMs: elapsedMs(), language: langCode(),
    agenda: $('noteTakerAgenda').value.trim(), summary: null, saved: false, dirty: false,
  }
  sessionId = null
  $('noteTakerEditor').value = text
  $('noteTakerCompleteTitle').value = $('noteTakerMeetingTitle').value.trim()
  $('noteTakerChip').hidden = true
  showComplete()
  if (modal.hidden) open()
  $('noteTakerEditor').focus()
  if (text.trim() && $('noteTakerAutoSave').checked) saveCurrent()
}
function hasUnsavedWork() { return !!(draft && $('noteTakerEditor').value.trim() && (!draft.saved || draft.dirty)) }
function newNote() {
  // Starting over discards whatever is on screen, so an unsaved note needs a second tap.
  const btn = $('noteTakerNew')
  if (hasUnsavedWork() && !newArmed) {
    btn.textContent = 'Discard unsaved note?'
    newArmed = setTimeout(() => { newArmed = null; btn.innerHTML = '<i class="ph ph-plus"></i> New note' }, 4000)
    return
  }
  clearTimeout(newArmed); newArmed = null; btn.innerHTML = '<i class="ph ph-plus"></i> New note'
  setState('idle'); segments = []; draft = null
  $('noteTakerEditor').value = ''; $('noteTakerMeetingTitle').value = ''; $('noteTakerCompleteTitle').value = ''; $('noteTakerAgenda').value = ''
  resetSetup(); checkForRecovery(); $('noteTakerMeetingTitle').focus()
}
async function copyNote() {
  const btn = $('noteTakerCopy')
  try { await navigator.clipboard.writeText($('noteTakerEditor').value); btn.innerHTML = '<i class="ph ph-check"></i> Copied' }
  catch { $('noteTakerEditor').select(); btn.innerHTML = '<i class="ph ph-copy"></i> Press Ctrl+C' }
  setTimeout(() => (btn.innerHTML = '<i class="ph ph-copy"></i> Copy'), 2000)
}
function downloadNote() {
  const name = ($('noteTakerCompleteTitle').value.trim() || 'meeting-notes').replace(/[\\/:*?"<>|]+/g, '-').trim().slice(0, 80)
  const a = document.createElement('a')
  const withSummary = !!draft?.summary
  const body = withSummary ? `${summaryText()}\n\n---\n\nTranscript\n\n${$('noteTakerEditor').value}` : $('noteTakerEditor').value
  a.href = URL.createObjectURL(new Blob([body], { type: 'text/plain;charset=utf-8' }))
  a.download = `${name}.${withSummary ? 'md' : 'txt'}`; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000)
}

// ---------- Saved notes: save, summarize, browse ----------
const langLabel = (code) => $('noteTakerLanguage').querySelector(`option[value="${code}"]`)?.text || ''
const fmtDate = (iso) => { const d = new Date(iso); return isNaN(d) ? '' : d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) }
const fmtMinutes = (ms) => (ms > 0 ? `${Math.max(1, Math.round(ms / 60000))} min` : '')
function relativeDay(iso) {
  const d = new Date(iso); if (isNaN(d)) return ''
  const days = Math.round((new Date().setHours(0, 0, 0, 0) - new Date(d).setHours(0, 0, 0, 0)) / 86400000)
  return days === 0 ? 'Today' : days === 1 ? 'Yesterday' : d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: d.getFullYear() === new Date().getFullYear() ? undefined : 'numeric' })
}
const setSaveState = (text, isError = false) => { const el = $('noteTakerSaveState'); el.textContent = text; el.dataset.error = String(isError); el.setAttribute('role', isError ? 'alert' : 'status') }
const setBtn = (id, icon, label, disabled = false) => { const b = $(id); b.disabled = disabled; b.querySelector('i').className = `ph ph-${icon}`; b.querySelector('span').textContent = label }

function showComplete() {
  show('complete')
  $('noteTakerMeta').textContent = [fmtDate(draft.createdAt), fmtMinutes(draft.durationMs) || null, langLabel(draft.language)].filter(Boolean).join(', ')
  $('noteTakerDelete').hidden = !draft.saved
  renderSummary()
  setView(draft.summary ? 'summary' : 'transcript')
  refreshSaveUi()
}
function refreshSaveUi() {
  if (!draft) return
  const hasText = !!$('noteTakerEditor').value.trim()
  const canSummarize = $('noteTakerEditor').value.trim().length >= MIN_SUMMARY_CHARS
  if (saving) setBtn('noteTakerSave', 'circle-notch', 'Saving', true)
  else if (!hasText) setBtn('noteTakerSave', 'floppy-disk', 'Save note', true)
  else if (draft.saved && !draft.dirty) setBtn('noteTakerSave', 'check', 'Saved', true)
  else setBtn('noteTakerSave', 'floppy-disk', draft.saved ? 'Save changes' : 'Save note')
  if (summarizing) setBtn('noteTakerSummarize', 'circle-notch', 'Summarizing', true)
  else setBtn('noteTakerSummarize', 'list-checks', draft.summary ? 'Summarize again' : 'Summarize', !canSummarize)
  $('noteTakerSummarize').title = canSummarize ? '' : 'Record a little more to get a summary'
  $('noteTakerSave').classList.toggle('is-busy', saving); $('noteTakerSummarize').classList.toggle('is-busy', summarizing)
  $('noteTakerDelete').hidden = !draft.saved
  if (saving || $('noteTakerSaveState').dataset.error === 'true') return
  setSaveState(!hasText ? 'Nothing was transcribed, so there is nothing to save.'
    : draft.saved && draft.dirty ? 'You have unsaved changes.'
    : draft.saved ? 'Saved to your notes. You can open it from Saved notes.'
    : 'Not saved yet. Save it to open this note later.')
}
function markEdited() { if (!draft) return; editVersion++; if (draft.saved) draft.dirty = true; $('noteTakerSaveState').dataset.error = 'false'; refreshSaveUi() }

async function saveCurrent() {
  if (!draft || saving || !$('noteTakerEditor').value.trim()) return
  saving = true; $('noteTakerSaveState').dataset.error = 'false'; setSaveState('Saving...'); refreshSaveUi()
  const version = editVersion
  try {
    await saveNote({ id: draft.id, title: $('noteTakerCompleteTitle').value.trim(), language: draft.language, durationMs: draft.durationMs, createdAt: draft.createdAt, transcript: $('noteTakerEditor').value, summary: draft.summary })
    draft.saved = true; draft.dirty = editVersion !== version
    savedNotes = null // the list is stale now; reload it next time it is opened
    saving = false; $('noteTakerSaveState').dataset.error = 'false'
  } catch (e) {
    saving = false; setSaveState(`${e.message} Your note is still on screen.`, true)
  }
  refreshSaveUi()
}

// ----- Summary -----
function renderSummary() {
  const box = $('noteTakerSummary'); const s = draft?.summary
  if (summarizing) { box.hidden = false; box.innerHTML = summarySkeleton(); return }
  if (!s) { box.hidden = true; box.innerHTML = ''; return }
  const list = (items) => `<ul>${items.map((t) => `<li>${escapeHtml(t)}</li>`).join('')}</ul>`
  const section = (title, body) => body ? `<section><h4>${title}</h4>${body}</section>` : ''
  const outline = s.sections?.length ? `<ol class="note-outline">${s.sections.map((x) => `<li><div><strong>${escapeHtml(x.title)}</strong>${x.summary ? `<small>${escapeHtml(x.summary)}</small>` : ''}</div></li>`).join('')}</ol>` : ''
  const agendaList = s.agendaCoverage?.length ? `<ul class="note-actions">${s.agendaCoverage.map((a) => `<li><span>${escapeHtml(a.item)}</span><small>${AGENDA_LABEL[a.status] || ''}</small></li>`).join('')}</ul>` : ''
  const actions = s.actionItems.length ? `<ul class="note-actions">${s.actionItems.map((a) => `<li><span>${escapeHtml(a.task)}</span>${a.owner || a.due || a.priority === 'high' ? `<small>${[a.owner, a.due, a.priority === 'high' ? 'High priority' : ''].filter(Boolean).map(escapeHtml).join(', ')}</small>` : ''}</li>`).join('')}</ul>` : ''
  box.hidden = false
  box.innerHTML = `<div class="note-summary-head"><h3>Summary</h3><div class="note-summary-tools"><button class="note-taker-ghost" id="noteTakerFollowUp" type="button"><i class="ph ph-envelope-simple"></i> Follow-up email</button><button class="note-taker-ghost" id="noteTakerCopySummary" type="button"><i class="ph ph-copy"></i> Copy summary</button></div></div>`
    + (s.overview ? `<p class="note-overview">${escapeHtml(s.overview)}</p>` : '')
    + section('Meeting outline', outline)
    + section('Agenda', agendaList)
    + section('Decisions', s.decisions.length ? list(s.decisions) : '')
    + section('Action items', actions)
    + section('Key points', s.keyPoints.length ? list(s.keyPoints) : '')
    + section('Open questions', s.openQuestions.length ? list(s.openQuestions) : '')
  $('noteTakerCopySummary').addEventListener('click', copySummary)
  $('noteTakerFollowUp').addEventListener('click', copyFollowUp)
}
// The loading state uses the real headings (they are known) and grey bars only where text will arrive,
// so nothing jumps when the summary lands. The Agenda block appears only if an agenda was entered.
function summarySkeleton() {
  const bar = (w, cls = '') => `<span class="sk ${cls}" style="width:${w}"></span>`
  const lines = ['100%', '95%', '64%'].map((w) => bar(w, 'sk-block')).join('')
  const bullets = (ws) => `<ul>${ws.map((w) => `<li>${bar(w)}</li>`).join('')}</ul>`
  const tasks = `<ul class="note-actions">${['72%', '58%'].map((w) => `<li>${bar(w)}<small>${bar('32%')}</small></li>`).join('')}</ul>`
  const outline = `<ol class="note-outline">${['40%', '52%', '34%'].map((w) => `<li><div><strong>${bar(w)}</strong><small>${bar('88%')}</small></div></li>`).join('')}</ol>`
  const agenda = draft?.agenda ? `<section><h4>Agenda</h4><ul class="note-actions">${['64%', '48%'].map((w) => `<li>${bar(w)}<small>${bar('22%')}</small></li>`).join('')}</ul></section>` : ''
  return `<div class="note-summary-head"><h3>Summary</h3></div><p class="note-overview" role="status" aria-label="Writing the summary">${lines}</p>`
    + `<section><h4>Meeting outline</h4>${outline}</section>${agenda}<section><h4>Decisions</h4>${bullets(['80%', '55%'])}</section>`
    + `<section><h4>Action items</h4>${tasks}</section><section><h4>Key points</h4>${bullets(['86%', '70%', '46%'])}</section>`
}
function followUpText() {
  const s = draft?.summary; if (!s) return ''
  const title = $('noteTakerCompleteTitle').value.trim() || 'our meeting'
  const list = (items) => items.map((l) => `- ${l}`).join('\n')
  const tasks = s.actionItems.map((a) => `- ${a.task}${a.owner || a.due ? ` (${[a.owner, a.due].filter(Boolean).join(', ')})` : ''}`).join('\n')
  return [`Subject: Follow-up: ${title}`, 'Hi all,', `Thank you for your time. Here is a short recap of ${title}.`, s.overview,
    s.decisions.length ? `Decisions\n${list(s.decisions)}` : '', tasks ? `Action items\n${tasks}` : '',
    s.openQuestions.length ? `Still open\n${list(s.openQuestions)}` : '', 'Please reply if anything here looks wrong or is missing.', 'Thanks'].filter(Boolean).join('\n\n')
}
async function copyFollowUp() {
  const btn = $('noteTakerFollowUp')
  try { await navigator.clipboard.writeText(followUpText()); btn.innerHTML = '<i class="ph ph-check"></i> Email copied' } catch { btn.innerHTML = 'Copy failed' }
  setTimeout(() => { if (btn.isConnected) btn.innerHTML = '<i class="ph ph-envelope-simple"></i> Follow-up email' }, 2000)
}
// Summary / Transcript switch. The tabs only exist once a summary exists or is being written.
function setView(v) {
  const has = !!(summarizing || draft?.summary)
  view = has ? v : 'transcript'
  $('noteTakerComplete').dataset.view = view
  $('noteTakerViewTabs').hidden = !has
  $('noteTakerViewSummary').setAttribute('aria-selected', String(view === 'summary'))
  $('noteTakerViewTranscript').setAttribute('aria-selected', String(view === 'transcript'))
}
function summaryText() {
  const s = draft?.summary; if (!s) return ''
  const block = (title, lines) => lines.length ? `${title}\n${lines.map((l) => `- ${l}`).join('\n')}` : ''
  return [$('noteTakerCompleteTitle').value.trim(), s.overview,
    block('Meeting outline', (s.sections || []).map((x) => (x.summary ? `${x.title}: ${x.summary}` : x.title))),
    block('Agenda', (s.agendaCoverage || []).map((a) => `${a.item} (${AGENDA_LABEL[a.status] || ''})`)),
    block('Decisions', s.decisions),
    block('Action items', s.actionItems.map((a) => [a.task, [a.owner, a.due].filter(Boolean).join(', ')].filter(Boolean).join(' (') + (a.owner || a.due ? ')' : ''))),
    block('Key points', s.keyPoints), block('Open questions', s.openQuestions)].filter(Boolean).join('\n\n')
}
async function copySummary() {
  const btn = $('noteTakerCopySummary')
  try { await navigator.clipboard.writeText(summaryText()); btn.innerHTML = '<i class="ph ph-check"></i> Copied' } catch { btn.innerHTML = 'Copy failed' }
  setTimeout(() => { if (btn.isConnected) btn.innerHTML = '<i class="ph ph-copy"></i> Copy summary' }, 2000)
}
async function summarizeCurrent() {
  if (!draft || summarizing) return
  summarizing = true; $('noteTakerSaveState').dataset.error = 'false'; renderSummary(); setView('summary'); refreshSaveUi()
  const target = draft
  let summary = null, failure = null
  try {
    summary = await summarizeNote({ transcript: $('noteTakerEditor').value, title: $('noteTakerCompleteTitle').value.trim(), agenda: target.agenda || '' })
  } catch (e) { failure = e }
  summarizing = false
  if (draft !== target) return // the person moved on to another note while this ran
  if (summary) {
    target.summary = summary
    if (!$('noteTakerCompleteTitle').value.trim() && summary.title) $('noteTakerCompleteTitle').value = summary.title // name untitled notes
    if (target.saved) target.dirty = true
  } else setSaveState(failure?.message || 'Could not summarize. Please try again.', true)
  renderSummary(); setView(target.summary ? 'summary' : 'transcript'); refreshSaveUi()
  if (summary && target.saved) saveCurrent() // keep the stored note in step with what is on screen
}

// ----- Saved notes list -----
function noteMatches(n, words) { const hay = `${n.title} ${n.searchText}`.toLowerCase(); return words.every((w) => hay.includes(w)) }
function groupLabel(iso) {
  const d = new Date(iso); if (isNaN(d)) return 'Earlier'
  const days = Math.round((new Date().setHours(0, 0, 0, 0) - new Date(d).setHours(0, 0, 0, 0)) / 86400000)
  return days <= 0 ? 'Today' : days === 1 ? 'Yesterday' : days < 7 ? 'This week' : days < 30 ? 'This month' : 'Earlier'
}
function groupHead(n, words) {
  if (words.length) return '' // search results stay in one flat list
  const label = groupLabel(n.updatedAt)
  if (label === lastGroup) return ''
  lastGroup = label
  return `<h4 class="note-group-label">${label}</h4>`
}
// Same markup and typography as a real row (title + date, meta, two-line preview), so the list does not shift when it loads.
function listSkeleton() {
  let n = 3
  try { const v = localStorage.getItem(LIST_COUNT_KEY); if (v !== null) n = Math.min(6, Math.max(0, Number(v) || 0)) } catch {}
  if (n === 0) return '<div class="note-taker-empty" role="status" aria-label="Loading saved notes"><span class="sk sk-block" style="width:150px;margin-inline:auto"></span><span class="sk sk-block" style="width:min(300px,90%);margin-inline:auto"></span><span class="sk" style="width:170px;height:44px;margin-top:var(--space-3)"></span></div>'
  const row = '<div class="note-row note-row--skeleton" aria-hidden="true"><span class="note-row-top"><strong><span class="sk sk-title"></span></strong><time><span class="sk sk-date"></span></time></span><span class="note-row-meta"><span class="sk sk-meta"></span></span><span class="note-row-preview"><span class="sk sk-block"></span><span class="sk sk-block"></span></span></div>'
  return `<div role="status" aria-label="Loading saved notes"><h4 class="note-group-label"><span class="sk" style="width:52px"></span></h4>${row.repeat(n)}</div>`
}
function renderSaved() {
  const list = $('noteTakerSavedList'); const err = $('noteTakerSavedError'); const limit = $('noteTakerSavedLimit')
  const count = $('noteTakerSavedCount')
  count.hidden = !savedNotes; count.textContent = savedNotes ? String(savedNotes.length) : ''
  limit.hidden = !(savedNotes && savedLimit); if (savedNotes && savedLimit) limit.textContent = `${savedNotes.length} of ${savedLimit} notes saved on your plan.`
  $('noteTakerSearch').disabled = !savedNotes?.length
  if (savedLoading) { err.hidden = true; list.innerHTML = listSkeleton(); return }
  if (savedFailed) { list.innerHTML = '<div class="note-taker-empty"><p>Your saved notes could not be loaded. They have not been changed.</p><button class="note-taker-secondary" id="noteTakerSavedRetry" type="button">Try again</button></div>'; $('noteTakerSavedRetry').addEventListener('click', () => loadSaved(true)); return }
  if (!savedNotes?.length) { list.innerHTML = '<div class="note-taker-empty"><p>No saved notes yet.</p><p class="note-empty-sub">Record a meeting, then choose Save note. Turn on Save to my notes when I finish to skip that step.</p><button class="note-taker-secondary" id="noteTakerSavedRecord" type="button"><i class="ph ph-microphone"></i> Start a recording</button></div>'; $('noteTakerSavedRecord').addEventListener('click', () => showRecordTab()); return }
  const words = searchTerm.toLowerCase().split(/\s+/).filter(Boolean)
  const rows = savedNotes.filter((n) => noteMatches(n, words))
  if (!rows.length) { list.innerHTML = `<div class="note-taker-empty"><p>No notes match "${escapeHtml(searchTerm)}".</p><p class="note-empty-sub">Search covers titles and summaries. Summarize a note to make it easier to find.</p></div>`; return }
  lastGroup = ''
  list.innerHTML = rows.map((n) => groupHead(n, words) + `<button class="note-row" type="button" data-id="${escapeHtml(n.id)}"><span class="note-row-top"><strong>${escapeHtml(n.title)}</strong><time datetime="${escapeHtml(n.updatedAt)}">${escapeHtml(relativeDay(n.updatedAt))}</time></span><span class="note-row-meta">${[fmtMinutes(n.durationMs), n.hasSummary ? 'Summarized' : ''].filter(Boolean).join(', ')}</span><span class="note-row-preview">${escapeHtml(n.preview)}</span></button>`).join('')
}
async function loadSaved(force = false) {
  if (savedLoading || (savedNotes && !force)) return renderSaved()
  savedLoading = true; savedFailed = false; renderSaved()
  try { const res = await listSavedNotes(); savedNotes = res.notes || []; savedLimit = res.limit || null; try { localStorage.setItem(LIST_COUNT_KEY, String(savedNotes.length)) } catch {} }
  catch (e) { savedFailed = true; savedNotes = null }
  savedLoading = false; renderSaved()
}
function showSavedTab() {
  show('saved'); $('noteTakerSavedError').hidden = true; discardArmedId = null
  loadSaved(savedNotes === null)
}
function showRecordTab() {
  if (draft && $('noteTakerEditor').value) return showComplete()
  resetSetup(); checkForRecovery()
}
async function openSaved(id, row) {
  const err = $('noteTakerSavedError'); err.hidden = true
  if (hasUnsavedWork() && draft.id !== id && discardArmedId !== id) {
    discardArmedId = id
    err.textContent = 'You have an unsaved note open. Select this note again to discard it and open this one.'; err.hidden = false
    return
  }
  discardArmedId = null; row.disabled = true; row.classList.add('is-loading')
  try {
    const note = await getSavedNote(id)
    segments = []
    draft = { id: note.id, createdAt: note.createdAt, durationMs: note.durationMs || 0, language: note.language, agenda: '', summary: note.summary || null, saved: true, dirty: false }
    $('noteTakerEditor').value = note.transcript; $('noteTakerCompleteTitle').value = note.title === 'Untitled meeting' ? '' : note.title
    editVersion++; setSaveState(''); $('noteTakerSaveState').dataset.error = 'false'
    showComplete(); $('noteTakerCompleteTitle').blur()
  } catch (e) {
    row.disabled = false; row.classList.remove('is-loading')
    err.textContent = e.message; err.hidden = false
    if (e.status === 404) loadSaved(true) // it was deleted elsewhere; refresh the list
  }
}
async function deleteCurrent() {
  if (!draft?.saved) return
  const btn = $('noteTakerDelete')
  if (!deleteArmed) {
    btn.innerHTML = '<i class="ph ph-trash"></i> Tap again to delete for good'
    deleteArmed = setTimeout(() => { deleteArmed = null; btn.innerHTML = '<i class="ph ph-trash"></i> Delete' }, 4000)
    return
  }
  clearTimeout(deleteArmed); deleteArmed = null; btn.disabled = true; btn.textContent = 'Deleting...'
  try {
    await deleteSavedNote(draft.id)
    savedNotes = null; draft = null; $('noteTakerEditor').value = ''; $('noteTakerCompleteTitle').value = ''
    btn.disabled = false; btn.innerHTML = '<i class="ph ph-trash"></i> Delete'
    showSavedTab()
  } catch (e) {
    btn.disabled = false; btn.innerHTML = '<i class="ph ph-trash"></i> Delete'
    setSaveState(e.message, true)
  }
}

$('noteTakerSave').addEventListener('click', saveCurrent)
$('noteTakerSummarize').addEventListener('click', summarizeCurrent)
$('noteTakerDelete').addEventListener('click', deleteCurrent)
$('noteTakerEditor').addEventListener('input', markEdited)
$('noteTakerCompleteTitle').addEventListener('input', markEdited)
$('noteTakerViewSummary').addEventListener('click', () => setView('summary'))
$('noteTakerViewTranscript').addEventListener('click', () => setView('transcript'))
$('noteTakerTabRecord').addEventListener('click', showRecordTab)
$('noteTakerTabSaved').addEventListener('click', showSavedTab)
$('noteTakerSearch').addEventListener('input', (e) => { searchTerm = e.target.value.trim(); renderSaved() })
$('noteTakerSavedList').addEventListener('click', (e) => { const row = e.target.closest('.note-row'); if (row) openSaved(row.dataset.id, row) })
$('noteTakerAutoSave').addEventListener('change', (e) => { try { localStorage.setItem(AUTOSAVE_PREF_KEY, e.target.checked ? '1' : '0') } catch {} })
$('noteTakerStart').addEventListener('click', start)
$('noteTakerPause').addEventListener('click', pause)
$('noteTakerStop').addEventListener('click', finish)
$('noteTakerClose').addEventListener('click', close)
$('noteTakerChip').addEventListener('click', open)
$('noteTakerNew').addEventListener('click', newNote)
$('noteTakerLanguage').addEventListener('change', updateLanguageHint)
$('noteTakerCopy').addEventListener('click', copyNote)
$('noteTakerDownload').addEventListener('click', downloadNote)
$('noteTakerAsk').addEventListener('click', () => { const input = $('composerInput'); input.value = `Please help me process these meeting notes:\n\n${$('noteTakerEditor').value}`; input.dispatchEvent(new Event('input', { bubbles: true })); close(); input.focus() })
modal.addEventListener('mousedown', (e) => { if (e.target === modal) close() })
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !modal.hidden) close() })
window.addEventListener('cognita:open-note-taker', open)
window.addEventListener('online', () => { refreshQuota(); if (state === 'degraded' && browserLang()) { clearTimeout(retryTimer); stopChunkLoop(); startPrimarySpeech() } })
// Coming back to the tab after upgrading (or after midnight UTC) should not leave a stale "used up" on screen.
window.addEventListener('focus', () => { if (!modal.hidden && quota && !quota.unlimited && quota.usedSeconds / quota.limitSeconds >= QUOTA_WARN_AT) refreshQuota() })
window.addEventListener('offline', () => { if (isActive()) setStatus('Offline', browserLang() ? 'Live transcription will resume when you reconnect' : 'Cloud transcription will resume when you reconnect') })
window.addEventListener('beforeunload', (e) => { if (isActive() || hasUnsavedWork()) { e.preventDefault(); e.returnValue = '' } })
