import { createNoteSession, patchNoteSession, persistNoteSegment, recoverNoteSession, transcribeChunk, getNoteQuota, listSavedNotes, getSavedNote, saveNote, deleteSavedNote, summarizeNote, askNote, compareNote, setTasksDone, uploadNoteAudio, getNoteAudio, deleteNoteAudio } from './note-taker-production.js'

const $ = (id) => document.getElementById(id)
const modal = $('noteTakerModal')
import { VoiceTracker, FRAME as VOICE_FRAME } from './note-voices.js'
import { SessionRecorder, audioSupported } from './note-audio.js'
import { loadVoices, saveVoices, matchVoices, rememberVoice, forgetVoice, isRememberable, cleanName, MAX_VOICES } from './note-voice-memory.js'
const RECOVERY_KEY = 'cognitaNoteTakerSession'
const AUTOSAVE_PREF_KEY = 'cognitaNoteTakerSaveOnFinish'
const MIN_SUMMARY_CHARS = 200 // matches saved-notes-endpoint.js
const AUTOSAVE_MS = 20000
const QUOTA_NOTICE_KEY = 'cognitaNoteQuotaNotice'
const LIST_COUNT_KEY = 'cognitaNoteListCount' // last known number of saved notes, so the loading skeleton has the right number of rows
const LABEL_PREF_KEY = 'cognitaNoteLabelSpeakers'
const AUDIO_PREF_KEY = 'cognitaNoteKeepAudio'
const SPEAKER_HUES = 6
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
// Speakers, audio, ask, tasks
let tracker = null, voiceAn = null, voiceTimer = null, recorder = null, restoredRun = false
let planAudioMB = null, asksPerDay = null, askQuotaText = '', asking = false, askSeq = 0
let clearArmed = null, saveAgain = false, forgetArmed = null
let voiceSession = null // what the last finished recording learned about each voice; kept in memory only, never saved with the note
// Questions asked while a meeting is still being recorded. run changes whenever a meeting starts or ends, so an answer
// that arrives late can tell which one it belongs to.
const liveAsk = { open: false, log: [], asking: false, limitText: '', unseen: false, run: 0 }
const MAX_SAVED_ASKS = 30 // the server keeps the newest 30 (saved-notes-endpoint.js)
let editing = false, lines = [], activeLine = -1, audioUrl = null, audioLoading = false, audioArmed = null, speedIdx = 0, dragging = false
let taskFilter = 'open', taskOwner = ''
const audio = document.getElementById('noteTakerAudio')
const SPEEDS = [1, 1.25, 1.5, 2]
const ASK_SUGGESTIONS = ['What did we decide?', 'Who is doing what, and by when?', 'What is still unresolved?', 'What concerns were raised?']

const ACTIVE = ['recording', 'paused', 'degraded', 'connecting']
const isActive = () => ACTIVE.includes(state)
const langCode = () => $('noteTakerLanguage').value
const browserLang = () => (Speech && LANGS[langCode()]?.browser) || null

function formatTime(ms) { const s = Math.max(0, Math.floor(ms / 1000)); return [Math.floor(s / 3600), Math.floor(s / 60) % 60, s % 60].map((n) => String(n).padStart(2, '0')).join(':') }
function elapsedMs() { return startedAt ? Date.now() - startedAt - pausedMs - (pauseAt ? Date.now() - pauseAt : 0) : 0 }
function elapsed() { return formatTime(elapsedMs()) }
function escapeHtml(v) { return v.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])) }
function setState(next) { state = next; $('noteTakerLive').dataset.state = next; $('noteTakerChip').dataset.state = next; updateLiveAskUi() }
function setStatus(text, detail = '') { $('noteTakerStatus').textContent = text; $('noteTakerConnection').textContent = detail }
// Errors before the live view exists must show in the setup view, otherwise they render into a hidden panel.
function showSetupError(text) { const el = $('noteTakerSetupError'); el.textContent = text; el.hidden = !text }
function show(view) {
  for (const v of ['Setup', 'Live', 'Complete', 'Saved', 'Tasks']) $(`noteTaker${v}`).hidden = v.toLowerCase() !== view
  $('noteTakerTabs').hidden = view === 'live' // the recording screen has no room for tabs
  const onSaved = view === 'saved', onTasks = view === 'tasks'
  $('noteTakerTabSaved').setAttribute('aria-selected', String(onSaved))
  $('noteTakerTabTasks').setAttribute('aria-selected', String(onTasks))
  $('noteTakerTabRecord').setAttribute('aria-selected', String(!onSaved && !onTasks))
  if (view !== 'setup') $('noteTakerRecoveryBanner').hidden = true
  if (view === 'complete' || view === 'saved' || view === 'tasks') hideNotice() // allowance notices belong to recording, not to reading notes
}

const multiSpeaker = () => new Set(segments.filter((s) => s.speaker != null).map((s) => s.speaker)).size > 1
function render() {
  const root = $('noteTakerTranscript')
  const multi = multiSpeaker() // a single voice needs no labels
  const rows = segments.map((s) => `<p class="note-segment"><time>${s.time}</time><span>${multi && s.speaker != null ? `<b class="spk spk-${s.speaker % SPEAKER_HUES}">${speakerLabel(s.speaker)}</b> ` : ''}${escapeHtml(s.text)}</span></p>`)
  if (interim) rows.push(`<p class="note-segment interim"><time></time><span>${escapeHtml(interim)}</span></p>`)
  if (!rows.length) {
    const cloud = !browserLang()
    root.innerHTML = `<p class="note-taker-empty">${cloud ? 'Speak as normal. Text appears after each pause, usually within a few seconds.' : 'Start speaking and the transcript will appear here.'}</p>`
    return
  }
  const nearBottom = root.scrollHeight - root.scrollTop - root.clientHeight < 80
  root.innerHTML = rows.join('')
  if (nearBottom) root.scrollTop = root.scrollHeight // don't yank the view while someone is reading back
  if (liveAsk.open) updateLiveAskUi() // new words may be enough to ask about
}
function saveRecoveryPointer() { if (sessionId) try { localStorage.setItem(RECOVERY_KEY, JSON.stringify({ sessionId, version: sessionVersion, title: $('noteTakerMeetingTitle').value.trim(), language: langCode(), startedAt })) } catch {} }
function clearRecoveryPointer() { try { localStorage.removeItem(RECOVERY_KEY) } catch {} }
const speakerLabel = (i) => `Speaker ${i + 1}`
const elapsedAt = (t) => Math.max(0, t - startedAt - pausedMs)
// range is the stretch of time the text was spoken in when it is known (cloud chunks). Otherwise it is everything
// heard since the previous segment was finalized. The timestamp is when the speaker started, so audio jumps land
// on the first word instead of after the last one.
function appendFinal(text, range = null) {
  text = (text || '').trim()
  if (!text) return
  const last = segments[segments.length - 1]
  if (last && last.text === text) return
  let speaker = null, vi, startMs = null
  if (tracker) {
    const t1 = range?.t1 ?? Date.now(), t0 = range?.t0 ?? tracker.cut
    if (!range) tracker.cut = t1
    speaker = tracker.assign(t0, t1); vi = tracker.segments.length - 1
    const p = tracker.segments[vi]?.p; if (p) startMs = Math.min(elapsedAt(p.start), elapsedMs())
  }
  const seg = { id: crypto.randomUUID(), time: startMs != null ? formatTime(startMs) : elapsed(), text, speaker, vi }
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
  if (q.audioMaxMB !== undefined) { planAudioMB = q.audioMaxMB; updateAudioOption() }
  if (q.asksPerDay !== undefined) asksPerDay = q.asksPerDay
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
  if (draft && $('noteTakerEditor').value) return show('complete')
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
  try { $('noteTakerLabelSpeakers').checked = localStorage.getItem(LABEL_PREF_KEY) !== '0'; $('noteTakerKeepAudio').checked = localStorage.getItem(AUDIO_PREF_KEY) === '1' } catch {}
  updateAudioOption(); renderVoiceSetup()
}
function updateAudioOption() {
  const box = $('noteTakerKeepAudio'), hint = $('noteTakerAudioSetupHint')
  if (!audioSupported()) { box.disabled = true; box.checked = false; hint.textContent = 'This browser cannot record audio for playback.'; return }
  if (planAudioMB === 0) { box.disabled = true; box.checked = false; hint.textContent = 'Keeping audio is not included in your plan.'; return }
  box.disabled = false
  const mins = planAudioMB ? Math.round((planAudioMB / 11) * 60) : 0
  hint.textContent = `Stored privately with the note so you can replay it and jump to any line.${mins ? ` Room for about ${mins >= 120 ? `${Math.round(mins / 60)} hours` : `${mins} minutes`} per note on your plan.` : ''}`
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
      if (await beginCapture(true)) saveRecoveryPointer(); else if (!isActive()) banner.hidden = false // blocked (e.g. allowance used up): the unfinished note stays restorable
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
    rec.onstop = () => { clearInterval(poll); resolve(voiced && parts.length ? { blob: new Blob(parts, { type: mimeType || 'audio/webm' }), ms: Date.now() - t0, t0, t1: Date.now() } : null) }
    rec.onerror = () => { clearInterval(poll); resolve(null) }
    chunkRecorder = rec
    rec.start()
  })
}
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function transcribeAndAppend({ blob, ms, t0, t1 }) {
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
      if (text && !HALLUCINATIONS.test(text)) { appendFinal(text, { t0, t1 }); render() }
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
async function beginCapture(restored = false) {
  if (!(await gateCloud())) return false
  if (!stream && !(await acquireMic())) return false
  show('live'); setState('connecting'); setStatus('Starting', ''); segments = segments || []; interim = ''
  pausedMs = 0; pauseAt = 0; startedAt = Date.now(); langOverride = null; freeOnly = false; inflightSec = 0; render()
  clearInterval(timer)
  timer = setInterval(() => { const t = elapsed(); $('noteTakerTimer').textContent = t; $('noteTakerChipTime').textContent = t }, 250)
  startLevelMeter()
  resetLiveAsk(); restoredRun = restored; startVoices(); startRecorder()
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
    setState('paused'); pauseAt = Date.now(); recorder?.pause() // keeps the audio timeline in step with the transcript, which also skips pauses
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
  recorder?.resume(); if (tracker) tracker.cut = Date.now()
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
  const rec = recorder ? await recorder.stop() : null; recorder = null // before the mic tracks end
  stopVoices()
  stopLevelMeter()
  stream?.getTracks().forEach((t) => t.stop()); stream = null
  if (interim.trim()) { appendFinal(interim); interim = '' }
  const speakers = labelSegments()
  const liveItems = endLiveAsk() // the conversation started during the meeting moves into the note
  const keepQuotaText = askQuotaText
  const text = segments.map((s) => `[${s.time}] ${s.speaker != null ? `${speakers[s.speaker] || speakerLabel(s.speaker)}: ` : ''}${s.text}`).join('\n\n')
  if (sessionId) { try { await patchNoteSession(sessionId, { version: sessionVersion, transcript: segments.map((s) => s.text).join(' '), status: 'completed', updatedAt: new Date().toISOString() }) } catch {} }
  clearRecoveryPointer()
  setState('completed')
  draft = {
    id: sessionId || crypto.randomUUID().replaceAll('-', ''),
    createdAt: new Date(startedAt).toISOString(), durationMs: elapsedMs(), language: langCode(),
    agenda: $('noteTakerAgenda').value.trim(), summary: null, saved: false, dirty: false,
    speakers, hasAudio: false, askLog: liveItems, liveNote: liveItems.length > 0, compare: null, voice: voiceSession,
    audio: rec ? { blob: rec.blob, type: rec.type, uploaded: false, skip: false } : null,
  }
  afterDraftChange()
  if (liveItems.length) askQuotaText = keepQuotaText
  for (const x of liveItems) if (x.loading) { x.owner = draft; asking = true } // still waiting: it will land in the note when it arrives
  sessionId = null
  $('noteTakerEditor').value = text
  $('noteTakerCompleteTitle').value = $('noteTakerMeetingTitle').value.trim()
  $('noteTakerChip').hidden = true
  showComplete()
  if (rec?.truncated) audioStatus(`The recording stopped at the ${planAudioMB || 30} MB your plan allows. The transcript covers the whole meeting.`, true)
  if (modal.hidden) open()
  if (text.trim() && $('noteTakerAutoSave').checked) saveCurrent()
}
const pendingAudio = () => !!(draft?.audio?.blob && !draft.audio.uploaded && !draft.audio.skip)
function hasUnsavedWork() { return !!(draft && $('noteTakerEditor').value.trim() && (!draft.saved || draft.dirty || pendingAudio())) }
function newNote() {
  // Starting over discards whatever is on screen, so an unsaved note needs a second tap.
  const btn = $('noteTakerNew')
  if (hasUnsavedWork() && !newArmed) {
    btn.textContent = 'Discard unsaved note?'
    newArmed = setTimeout(() => { newArmed = null; btn.innerHTML = '<i class="ph ph-plus"></i> New note' }, 4000)
    return
  }
  clearTimeout(newArmed); newArmed = null; btn.innerHTML = '<i class="ph ph-plus"></i> New note'
  setState('idle'); segments = []; draft = null; afterDraftChange()
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
  const parts = [summaryText(), conversationText()].filter(Boolean) // summary, then questions and answers, then the transcript
  const body = parts.length ? `${parts.join('\n\n---\n\n')}\n\n---\n\nTranscript\n\n${$('noteTakerEditor').value}` : $('noteTakerEditor').value
  a.href = URL.createObjectURL(new Blob([body], { type: 'text/plain;charset=utf-8' }))
  a.download = `${name}.${parts.length ? 'md' : 'txt'}`; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000)
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
  renderReader(); renderSummary(); renderAskPane(); syncAudioBar()
  setView(draft.summary ? 'summary' : 'transcript')
  refreshSaveUi()
}
function refreshSaveUi() {
  if (!draft) return
  const hasText = !!$('noteTakerEditor').value.trim()
  const canSummarize = $('noteTakerEditor').value.trim().length >= MIN_SUMMARY_CHARS
  if (saving) setBtn('noteTakerSave', 'circle-notch', 'Saving', true)
  else if (!hasText) setBtn('noteTakerSave', 'floppy-disk', 'Save note', true)
  else if (draft.saved && !draft.dirty && pendingAudio()) setBtn('noteTakerSave', 'speaker-high', 'Save audio')
  else if (draft.saved && !draft.dirty) setBtn('noteTakerSave', 'check', 'Saved', true)
  else setBtn('noteTakerSave', 'floppy-disk', draft.saved ? 'Save changes' : 'Save note')
  if (summarizing) setBtn('noteTakerSummarize', 'circle-notch', 'Summarizing', true)
  else setBtn('noteTakerSummarize', 'list-checks', draft.summary ? 'Summarize again' : 'Summarize', !canSummarize)
  $('noteTakerSummarize').title = canSummarize ? '' : 'Record a little more to get a summary'
  $('noteTakerSave').classList.toggle('is-busy', saving); $('noteTakerSummarize').classList.toggle('is-busy', summarizing)
  $('noteTakerDelete').hidden = !draft.saved
  $('noteTakerDeleteAudio').hidden = !audioAvailable()
  updateAskUi()
  if (saving || $('noteTakerSaveState').dataset.error === 'true') return
  setSaveState(!hasText ? 'Nothing was transcribed, so there is nothing to save.'
    : draft.saved && draft.dirty ? 'You have unsaved changes.'
    : draft.saved && pendingAudio() ? 'The note is saved. Save again to add its audio recording.'
    : draft.saved ? 'Saved to your notes. You can open it from Saved notes.'
    : 'Not saved yet. Save it to open this note later.')
}
function markEdited() { if (!draft) return; editVersion++; if (draft.saved) draft.dirty = true; $('noteTakerSaveState').dataset.error = 'false'; refreshSaveUi() }

// Saves now, or as soon as the save in progress ends, so a change made while saving is never left behind.
function requestSave() { if (saving) saveAgain = true; else saveCurrent() }
async function saveCurrent() {
  if (!draft || saving || !$('noteTakerEditor').value.trim()) return
  const target = draft
  redetectSpeakers()
  const needNote = !target.saved || target.dirty
  if (!needNote && !pendingAudio()) return
  saving = true; $('noteTakerSaveState').dataset.error = 'false'; setSaveState(needNote ? 'Saving...' : 'Saving audio...'); refreshSaveUi()
  const version = editVersion
  let failed = false
  try {
    if (needNote) {
      await saveNote({ id: target.id, title: $('noteTakerCompleteTitle').value.trim(), language: target.language, durationMs: target.durationMs, createdAt: target.createdAt, transcript: $('noteTakerEditor').value, speakers: target.speakers || [], summary: target.summary, askLog: serializeAskLog(target.askLog) })
      target.saved = true; target.dirty = editVersion !== version
      savedNotes = null // the list is stale now; reload it next time it is opened
    }
    if (target === draft && pendingAudio()) {
      setSaveState('Saving audio...')
      try { await uploadNoteAudio(target.id, target.audio.blob); target.audio.uploaded = true; target.hasAudio = true; savedNotes = null }
      catch (e) {
        if ([403, 413, 415].includes(e.status)) { target.audio.skip = true; audioStatus('This recording could not be kept and will be lost when you close the note.', true) } // will not succeed on retry
        throw Object.assign(e, { audioFailed: true })
      }
    }
    saving = false; $('noteTakerSaveState').dataset.error = 'false'
  } catch (e) {
    saving = false; failed = true
    setSaveState(e.audioFailed ? `${e.message}${/saved/i.test(e.message) ? '' : ' The note itself is saved.'}` : `${e.message} Your note is still on screen.`, true)
  }
  syncAudioBar(); refreshSaveUi()
  if (saveAgain) { saveAgain = false; if (!failed && draft === target && target.saved && target.dirty) saveCurrent() }
}

// ----- Summary -----
function renderSummary() {
  const box = $('noteTakerSummary'); const s = draft?.summary
  if (summarizing) { box.hidden = false; box.innerHTML = summarySkeleton(); return }
  if (!s) {
    const enough = $('noteTakerEditor').value.trim().length >= MIN_SUMMARY_CHARS
    box.hidden = false
    box.innerHTML = `<div class="note-empty"><h3>No summary yet</h3><p>${enough ? 'Get the decisions, action items, an outline and the open questions from this meeting.' : 'The transcript is too short to summarize. Record a little more, then come back.'}</p>${enough ? '<button class="note-taker-primary" id="noteTakerSummarizeEmpty" type="button"><i class="ph ph-list-checks"></i> Summarize this meeting</button>' : ''}</div>`
    $('noteTakerSummarizeEmpty')?.addEventListener('click', summarizeCurrent)
    return
  }
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
    + '<section class="note-compare" id="noteTakerCompare"></section>'
  renderCompare()
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
// Transcript / Summary / Ask. The tabs are always there; an empty Summary or Ask explains what it needs.
function setView(v) {
  view = ['transcript', 'summary', 'ask'].includes(v) ? v : 'transcript'
  $('noteTakerComplete').dataset.view = view
  for (const [k, id] of [['transcript', 'noteTakerViewTranscript'], ['summary', 'noteTakerViewSummary'], ['ask', 'noteTakerViewAsk']]) $(id).setAttribute('aria-selected', String(view === k))
  if (view === 'ask') updateAskUi()
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
    target.summary = summary; target.compare = null
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
function renderSaved() { renderSavedList(); renderTasks() }
function renderSavedList() {
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
async function openSaved(id, row = null) {
  const err = row ? $('noteTakerSavedError') : $('noteTakerTasksError'); err.hidden = true
  if (hasUnsavedWork() && draft.id !== id && discardArmedId !== id) {
    discardArmedId = id
    err.textContent = 'You have an unsaved note open. Select this note again to discard it and open this one.'; err.hidden = false
    return
  }
  discardArmedId = null; if (row) { row.disabled = true; row.classList.add('is-loading') }
  try {
    const note = await getSavedNote(id)
    segments = []
    draft = { id: note.id, createdAt: note.createdAt, durationMs: note.durationMs || 0, language: note.language, agenda: '', summary: note.summary || null, saved: true, dirty: false, speakers: note.speakers || [], hasAudio: !!note.hasAudio, audio: null, askLog: loadAskLog(note.askLog), compare: null }
    afterDraftChange()
    $('noteTakerEditor').value = note.transcript; $('noteTakerCompleteTitle').value = note.title === 'Untitled meeting' ? '' : note.title
    editVersion++; setSaveState(''); $('noteTakerSaveState').dataset.error = 'false'
    showComplete(); $('noteTakerCompleteTitle').blur()
  } catch (e) {
    if (row) { row.disabled = false; row.classList.remove('is-loading') }
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
    savedNotes = null; draft = null; afterDraftChange(); $('noteTakerEditor').value = ''; $('noteTakerCompleteTitle').value = ''
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

// ═══════════════════════════════════════════════════════════════════════════
// Speakers, audio playback, Ask, Tasks, recurring meetings
// ═══════════════════════════════════════════════════════════════════════════

// ---------- Speaker labels while recording ----------
// See note-voices.js for how voices are told apart, and for its limits. Everything here runs on the device.
function startVoices() {
  stopVoices(); tracker = null
  if (!$('noteTakerLabelSpeakers').checked || !audioCtx || !sourceNode) return
  try {
    tracker = new VoiceTracker(audioCtx.sampleRate); tracker.reset()
    voiceAn = audioCtx.createAnalyser(); voiceAn.fftSize = VOICE_FRAME; voiceAn.smoothingTimeConstant = 0
    sourceNode.connect(voiceAn)
    const buf = new Float32Array(VOICE_FRAME)
    voiceTimer = setInterval(() => { if (!voiceAn || !tracker || state === 'paused') return; voiceAn.getFloatTimeDomainData(buf); tracker.push(buf, Date.now()) }, 50)
  } catch { tracker = null } // labels are a bonus: never let them break a recording
}
function stopVoices() { clearInterval(voiceTimer); voiceTimer = null; try { voiceAn?.disconnect() } catch {} voiceAn = null }
// After the meeting: re-cluster with everything heard, then number voices by first appearance. One voice = no labels.
// Voices the person saved on this device are compared last, and only a clear, unambiguous match gets a real name.
function labelSegments() {
  voiceSession = null
  if (!tracker) return []
  let detail = null
  try { detail = tracker.finalizeDetailed() } catch { detail = null }
  tracker = null
  const final = detail?.labels || []
  const used = new Set()
  for (const sg of segments) { if (sg.vi !== undefined && final[sg.vi] !== undefined) { sg.speaker = final[sg.vi]; used.add(sg.speaker) } else sg.speaker = null }
  if (used.size < 2) { segments.forEach((sg) => (sg.speaker = null)); return [] }
  const clusters = detail.voices.filter((v) => used.has(v.label))
  let matched = new Map()
  try { const saved = loadVoices(voiceUid()); if (saved.length) matched = matchVoices(clusters, detail.sigma, saved) } catch { matched = new Map() } // a failed match must never break finishing
  const names = Array.from({ length: Math.max(...used) + 1 }, (_, i) => matched.get(i)?.name || speakerLabel(i))
  voiceSession = { sigma: detail.sigma, clusters: {}, matched: new Set(matched.size ? [...matched.values()].map((v) => v.name) : []), offer: null, note: '' }
  for (const cl of clusters) voiceSession.clusters[names[cl.label]] = { c: cl.c, lf0: cl.lf0, n: cl.n }
  return names
}
function startRecorder() {
  recorder?.discard(); recorder = null
  const keep = $('noteTakerKeepAudio')
  if (restoredRun || !keep.checked || keep.disabled || !stream) return // a restored note has lost its earlier audio
  recorder = new SessionRecorder(stream, (planAudioMB || 30) * 1048576)
  if (!recorder.start()) recorder = null
}

// ---------- Remembered voices ----------
// The rules live in note-voice-memory.js. This part is only the screens: the list on the setup page, and the two short
// messages on a finished note ("matched to saved voices" and "Remember this voice?"). Everything stays on this device.
const voiceUid = () => { try { return window.Auth?.getCurrentUser?.()?.uid || null } catch { return null } }
function renderVoiceSetup() {
  const uid = voiceUid(), list = uid ? loadVoices(uid) : [], ul = $('noteTakerVoiceList')
  $('noteTakerVoiceEmpty').hidden = list.length > 0
  $('noteTakerVoiceEmpty').textContent = uid ? 'No voices are remembered. Nothing is stored unless you choose it after a meeting.' : 'Sign in to use remembered voices.'
  ul.innerHTML = list.map((v) => `<li><span class="note-voice-name">${escapeHtml(v.name)}</span><button class="note-taker-ghost" type="button" data-forget="${escapeHtml(v.name)}" aria-label="Forget ${escapeHtml(v.name)}'s voice"><i class="ph ph-trash"></i> Forget</button></li>`).join('')
  const all = $('noteTakerVoicesForget'); all.hidden = list.length < 2; disarmForget()
}
function disarmForget() { clearTimeout(forgetArmed); forgetArmed = null; $('noteTakerVoicesForget').innerHTML = 'Forget all' }
function forgetVoiceClick(name) {
  const uid = voiceUid(); if (!uid) return
  saveVoices(uid, forgetVoice(loadVoices(uid), name)); renderVoiceSetup()
  if (draft?.voice) { draft.voice.matched.delete(name); renderVoiceBar() }
}
function forgetAllClick() {
  const uid = voiceUid(); if (!uid) return
  if (!forgetArmed) { $('noteTakerVoicesForget').innerHTML = 'Tap again to forget all'; forgetArmed = setTimeout(disarmForget, 4000); return }
  disarmForget(); saveVoices(uid, []); renderVoiceSetup()
  if (draft?.voice) { draft.voice.matched.clear(); renderVoiceBar() }
}
// A name was changed on the finished note. The old match (if there was one) is now known to be wrong or renamed, so it
// no longer counts, and the new name can be offered for remembering.
function voiceAfterRename(oldName, name) {
  const v = draft?.voice; if (!v) return
  const cl = v.clusters[oldName]
  if (cl && !v.clusters[name]) v.clusters[name] = cl
  delete v.clusters[oldName]
  v.matched.delete(oldName); v.note = ''
  v.offer = voiceUid() && v.clusters[name] && isRememberable(name) ? cleanName(name) : null
  renderVoiceBar()
}
function renderVoiceBar() {
  const bar = $('noteTakerVoiceBar'), v = draft?.voice
  const rows = []
  if (v?.matched.size) {
    const n = v.matched.size
    rows.push(`<div class="note-voice-row"><span>${n === 1 ? '1 speaker was' : `${n} speakers were`} matched to saved voices. Wrong? Tap a name to fix.</span><button class="note-taker-secondary" type="button" data-vact="confirm">Looks right</button></div>`)
  }
  if (v?.offer) {
    rows.push(`<div class="note-voice-row"><span>Remember ${escapeHtml(v.offer)}'s voice for next time? Only a summary of how it sounds is kept, on this device only.</span><span class="note-voice-actions"><button class="note-taker-primary" type="button" data-vact="remember">Remember this voice</button><button class="note-taker-ghost" type="button" data-vact="skip">Not now</button></span></div>`)
  }
  if (v?.note) rows.push(`<p class="note-voice-note" role="status">${escapeHtml(v.note)}</p>`)
  bar.innerHTML = rows.join(''); bar.hidden = !rows.length
}
function voiceBarClick(e) {
  const act = e.target.closest('[data-vact]')?.dataset.vact, v = draft?.voice, uid = voiceUid()
  if (!act || !v) return
  if (act === 'skip') { v.offer = null; v.note = '' }
  else if (act === 'confirm') {
    let list = loadVoices(uid), changed = 0
    for (const name of v.matched) { const cl = v.clusters[name]; if (!cl) continue; const r = rememberVoice(list, name, cl, v.sigma); if (r.status === 'updated') { list = r.voices; changed++ } }
    const ok = !changed || saveVoices(uid, list)
    v.matched.clear(); v.note = ok ? 'Thanks. Saved voices are updated slowly, so they improve over time.' : 'Could not update saved voices on this device.'
  } else if (act === 'remember') {
    const name = v.offer, cl = name && v.clusters[name]
    if (!uid || !cl) { v.offer = null; v.note = 'Sign in to remember voices.' }
    else {
      const r = rememberVoice(loadVoices(uid), name, cl, v.sigma)
      if (r.status === 'full') v.note = `You already remember ${MAX_VOICES} voices. Forget one on the setup screen first, then try again.`
      else if (r.status === 'invalid') { v.offer = null; v.note = 'That name cannot be saved. Use a real name, not "Speaker 1".' }
      else if (!saveVoices(uid, r.voices)) v.note = 'Could not save on this device. Your browser may be blocking storage.'
      else { v.offer = null; v.matched.delete(name); v.note = r.status === 'updated' ? `${name}'s saved voice was updated.` : `${name}'s voice is remembered on this device. You can remove it from the setup screen.` }
    }
  }
  renderVoiceBar(); renderVoiceSetup()
}

// ---------- Transcript reader ----------
// The editable text stays the single source of truth: "[hh:mm:ss] Name: words" blocks. The reader is a view of it, so
// old notes, editing, search and the summary all keep working, and fixing a speaker just rewrites a line prefix.
const STAMP_LINE = /^\[(\d{2}):(\d{2}):(\d{2})\]\s*([\s\S]*)$/
function parseTranscript(text, names) {
  const known = [...names].sort((a, b) => b.length - a.length)
  return text.split(/\n{2,}/).map((b) => b.trim()).filter(Boolean).map((block, i) => {
    const m = block.match(STAMP_LINE)
    let time = null, sec = null, rest = block
    if (m) { time = `${m[1]}:${m[2]}:${m[3]}`; sec = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]); rest = m[4] }
    let speaker = null
    for (const n of known) if (rest.startsWith(`${n}: `)) { speaker = n; rest = rest.slice(n.length + 2); break }
    return { i, time, sec, speaker, text: rest }
  })
}
const serializeLines = (ls) => ls.map((l) => `${l.time ? `[${l.time}] ` : ''}${l.speaker ? `${l.speaker}: ` : ''}${l.text}`).join('\n\n')
// If the person retyped a name in the text editor, notice it: a prefix that repeats on many lines is a speaker.
function redetectSpeakers() {
  if (!draft) return
  const counts = new Map(); let total = 0
  for (const b of $('noteTakerEditor').value.split(/\n{2,}/)) {
    const m = b.trim().match(/^\[\d{2}:\d{2}:\d{2}\]\s*([^\n:\[\]]{1,32}): /)
    if (/^\s*\[\d{2}:\d{2}:\d{2}\]/.test(b)) total++
    if (m) counts.set(m[1].trim(), (counts.get(m[1].trim()) || 0) + 1)
  }
  const keep = (draft.speakers || []).filter((n) => counts.has(n))
  const added = [...counts].filter(([n, c]) => c >= 3 && !keep.includes(n) && n.split(/\s+/).length <= 4 && (keep.length || c / Math.max(1, total) >= 0.3)).map(([n]) => n)
  draft.speakers = [...keep, ...added].slice(0, 12)
}
const hueOf = (name) => Math.max(0, (draft?.speakers || []).indexOf(name)) % SPEAKER_HUES
function renderReader() {
  const box = $('noteTakerReader'); const hint = $('noteTakerSpeakerHint')
  renderVoiceBar()
  if (!draft) { box.innerHTML = ''; hint.textContent = ''; return }
  lines = parseTranscript($('noteTakerEditor').value, draft.speakers || [])
  const labelled = !!draft.speakers?.length, playable = audioAvailable()
  hint.textContent = [labelled ? 'Speakers are matched by software. Tap a name to fix a line or rename a speaker.' : '', playable ? 'Tap a time to play from there.' : ''].filter(Boolean).join(' ')
  if (!lines.length) { box.innerHTML = '<p class="note-taker-empty">Nothing was transcribed.</p>'; return }
  let prev = Symbol()
  box.innerHTML = lines.map((l) => {
    const turn = labelled && l.speaker !== prev; prev = l.speaker
    const time = l.sec == null ? '<span class="note-line-time"></span>'
      : playable ? `<button class="note-line-time" type="button" data-sec="${l.sec}" aria-label="Play from ${l.time}">${l.time}</button>` : `<time class="note-line-time">${l.time}</time>`
    const chip = turn ? `<button class="spk spk-${l.speaker ? hueOf(l.speaker) : 'none'}" type="button" data-i="${l.i}" aria-haspopup="menu">${escapeHtml(l.speaker || 'Unassigned')}</button>` : ''
    return `<div class="note-line${turn ? ' is-turn' : ''}" data-i="${l.i}">${time}<div class="note-line-body">${chip}<p class="note-line-text${playable && l.sec != null ? ' is-seekable' : ''}">${escapeHtml(l.text)}</p></div></div>`
  }).join('')
  activeLine = -1
}
function setEditing(on) {
  editing = on
  $('noteTakerEditor').hidden = !on; $('noteTakerReader').hidden = on
  $('noteTakerEditToggle').innerHTML = on ? '<i class="ph ph-check"></i> <span>Done editing</span>' : '<i class="ph ph-pencil-simple"></i> <span>Edit text</span>'
  closeSpeakerMenu()
  if (on) $('noteTakerEditor').focus(); else { redetectSpeakers(); renderReader() }
}
function commitLines(ls) {
  const used = [...new Set(ls.map((l) => l.speaker).filter(Boolean))]
  draft.speakers = [...(draft.speakers || []).filter((n) => used.includes(n)), ...used.filter((n) => !(draft.speakers || []).includes(n))].slice(0, 12)
  $('noteTakerEditor').value = serializeLines(ls)
  markEdited(); renderReader()
}
function closeSpeakerMenu() { $('noteTakerSpkMenu')?.remove() }
function openSpeakerMenu(btn) {
  closeSpeakerMenu()
  const i = Number(btn.dataset.i), cur = lines.find((l) => l.i === i)?.speaker || null
  const m = document.createElement('div'); m.className = 'note-spk-menu'; m.id = 'noteTakerSpkMenu'; m.setAttribute('role', 'menu'); m.dataset.i = String(i)
  m.innerHTML = (draft.speakers || []).map((n) => `<button type="button" role="menuitemradio" aria-checked="${n === cur}" data-act="assign" data-name="${escapeHtml(n)}"><span class="spk-dot spk-${hueOf(n)}"></span>${escapeHtml(n)}</button>`).join('')
    + ((draft.speakers || []).length < 12 ? '<button type="button" role="menuitem" data-act="new"><i class="ph ph-plus"></i> New speaker</button>' : '')
    + (cur ? `<form class="note-spk-rename" data-old="${escapeHtml(cur)}"><input maxlength="40" value="${escapeHtml(cur)}" aria-label="Rename ${escapeHtml(cur)}"><button type="submit">Rename everywhere</button></form>` : '')
  btn.closest('.note-line-body').appendChild(m)
  m.querySelector('button, input')?.focus()
}
function nextSpeakerName() { let n = (draft.speakers || []).length + 1; while ((draft.speakers || []).includes(speakerLabel(n - 1))) n++; return speakerLabel(n - 1) }
function assignSpeaker(i, name) { const ls = parseTranscript($('noteTakerEditor').value, draft.speakers || []); if (!ls[i]) return; ls[i].speaker = name; commitLines(ls) }
function renameSpeaker(oldName, raw) {
  const name = raw.replace(/[:\[\]\n]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 40)
  if (!name || name === oldName) return closeSpeakerMenu()
  const ls = parseTranscript($('noteTakerEditor').value, draft.speakers || []) // a name that already exists merges the two
  ls.forEach((l) => { if (l.speaker === oldName) l.speaker = name })
  draft.speakers = draft.speakers.map((n) => (n === oldName ? name : n))
  commitLines(ls)
  voiceAfterRename(oldName, name)
}

// ---------- Audio playback ----------
const audioAvailable = () => !!(draft && (draft.audio?.blob || draft.hasAudio))
const fmtClock = (sec) => { sec = Math.max(0, Math.floor(sec || 0)); const h = Math.floor(sec / 3600), m = Math.floor(sec / 60) % 60, r = sec % 60; return `${h ? `${h}:${String(m).padStart(2, '0')}` : m}:${String(r).padStart(2, '0')}` }
const audioDuration = () => (isFinite(audio.duration) && audio.duration > 0 ? audio.duration : (draft?.durationMs || 0) / 1000)
function audioStatus(text, isError = false) { const el = $('noteTakerAudioStatus'); el.textContent = text; el.hidden = !text; el.dataset.error = String(isError) }
function resetAudioPlayer() {
  audio.pause(); audio.removeAttribute('src'); try { audio.load() } catch {}
  if (audioUrl) URL.revokeObjectURL(audioUrl)
  audioUrl = null; audioLoading = false; activeLine = -1; dragging = false; audioStatus(''); syncAudioBar()
}
function afterDraftChange() { resetAudioPlayer(); if (editing) setEditing(false); closeSpeakerMenu(); disarmClear(); askQuotaText = ''; $('noteTakerAskInput').value = '' }
function syncAudioBar() {
  const bar = $('noteTakerAudioBar'), has = audioAvailable()
  bar.hidden = !has
  if (!has) return
  const ready = !!audioUrl, playing = ready && !audio.paused, dur = audioDuration()
  $('noteTakerAudioPlay').innerHTML = `<i class="ph ph-${audioLoading ? 'circle-notch' : playing ? 'pause' : 'play'}"></i>`
  $('noteTakerAudioPlay').classList.toggle('is-busy', audioLoading)
  $('noteTakerAudioPlay').setAttribute('aria-label', playing ? 'Pause recording' : 'Play recording')
  $('noteTakerAudioSeek').disabled = !ready
  if (!dragging) $('noteTakerAudioSeek').value = ready && dur ? String(Math.round((audio.currentTime / dur) * 1000)) : '0'
  $('noteTakerAudioTime').textContent = ready ? `${fmtClock(audio.currentTime)} / ${fmtClock(dur)}` : audioLoading ? 'Loading recording...' : `Recording${dur ? `, ${fmtClock(dur)}` : ''}`
}
// Recorded webm often reports an infinite duration until the browser has read to the end. Nudging the playhead far
// ahead makes it work the real length out, so the seek bar is accurate.
function prepareAudio() {
  return new Promise((resolve) => {
    const done = () => { audio.currentTime = 0; audio.playbackRate = SPEEDS[speedIdx]; resolve() }
    const settle = () => {
      if (isFinite(audio.duration)) return done()
      const fix = () => { if (isFinite(audio.duration)) { audio.removeEventListener('durationchange', fix); done() } }
      audio.addEventListener('durationchange', fix); audio.currentTime = 1e101
      setTimeout(() => { audio.removeEventListener('durationchange', fix); done() }, 3000)
    }
    if (audio.readyState >= 1) settle(); else audio.addEventListener('loadedmetadata', settle, { once: true })
    audio.addEventListener('error', resolve, { once: true })
    audio.load()
  })
}
async function ensureAudio() {
  if (audioUrl) return true
  if (audioLoading || !draft) return false
  const target = draft
  audioLoading = true; audioStatus(''); syncAudioBar()
  try {
    const blob = target.audio?.blob || await getNoteAudio(target.id)
    if (draft !== target) return false
    audioUrl = URL.createObjectURL(blob); audio.src = audioUrl
    await prepareAudio()
    audioLoading = false; syncAudioBar()
    return true
  } catch (e) {
    audioLoading = false
    if (draft === target) { audioStatus(e.status === 404 ? 'This note has no saved audio any more.' : (e.message || 'Could not load the audio.'), true); if (e.status === 404) { target.hasAudio = false; renderReader() } }
    syncAudioBar(); return false
  }
}
async function playAt(sec) {
  if (!(await ensureAudio())) return
  audio.currentTime = Math.max(0, sec - 0.5) // start a beat early so the first word is not clipped
  audio.play().catch(() => syncAudioBar()) // iOS may ask for one more tap after the recording loads
}
async function togglePlay() {
  if (!audioUrl && !(await ensureAudio())) return
  if (audio.paused) audio.play().catch(() => {}); else audio.pause()
}
function syncPlayhead() {
  syncAudioBar()
  if (!audioUrl) return
  const t = audio.currentTime + 0.5
  let idx = -1
  for (let k = 0; k < lines.length; k++) if (lines[k].sec != null && lines[k].sec <= t) idx = k
  if (idx === activeLine) return
  const rows = $('noteTakerReader').children
  if (rows[activeLine]) rows[activeLine].classList.remove('is-playing')
  activeLine = idx
  if (rows[idx]) {
    rows[idx].classList.add('is-playing')
    if (!audio.paused && view === 'transcript' && !editing) rows[idx].scrollIntoView({ block: 'nearest', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' })
  }
}
async function deleteAudio() {
  if (!audioAvailable()) return
  const btn = $('noteTakerDeleteAudio'), label = '<i class="ph ph-speaker-slash"></i> Delete audio'
  if (!audioArmed) { btn.innerHTML = '<i class="ph ph-speaker-slash"></i> Tap again to delete the audio'; audioArmed = setTimeout(() => { audioArmed = null; btn.innerHTML = label }, 4000); return }
  clearTimeout(audioArmed); audioArmed = null; btn.disabled = true; btn.textContent = 'Deleting...'
  const target = draft
  try {
    if (target.hasAudio) await deleteNoteAudio(target.id)
    savedNotes = null; target.hasAudio = false; target.audio = null
    if (draft === target) { resetAudioPlayer(); audioStatus('The audio was deleted. The transcript is kept.'); renderReader() }
  } catch (e) { audioStatus(e.message || 'Could not delete the audio.', true) }
  btn.disabled = false; btn.innerHTML = label; refreshSaveUi()
}

// ---------- Ask this meeting ----------
function askItemHtml(x) {
  const q = `<p class="note-ask-q">${escapeHtml(x.q)}</p>`
  if (x.loading) return `${q}<div class="note-ask-a" role="status" aria-label="Finding the answer"><span class="sk sk-block" style="width:96%"></span><span class="sk sk-block" style="width:88%"></span><span class="sk sk-block" style="width:52%"></span><span class="sk" style="width:120px;height:28px;margin-top:10px"></span></div>`
  if (x.error) return `${q}<div class="note-ask-a is-error"><p>${escapeHtml(x.error)}</p><button class="note-taker-ghost" type="button" data-retry="${x.n}"><i class="ph ph-arrow-clockwise"></i> Try again</button></div>`
  const src = x.sources?.length ? `<div class="note-ask-src"><span>Heard at</span>${x.sources.map((t) => `<button class="note-src" type="button" data-at="${t}">${t}</button>`).join('')}</div>` : ''
  return `${q}<div class="note-ask-a${x.found ? '' : ' is-empty'}"><p>${escapeHtml(x.a)}</p>${x.partial ? '<small>This is a long meeting, so only the passages closest to your question were searched.</small>' : ''}${src}</div>`
}
// What is kept with a note: finished answers only, newest 30. The server applies the same rules again.
const isFinished = (x) => !!x && !x.loading && !x.error && typeof x.a === 'string' && !!x.a
function serializeAskLog(log) {
  return (log || []).filter(isFinished).slice(-MAX_SAVED_ASKS).map((x) => ({ q: x.q, a: x.a, sources: x.sources || [], found: x.found !== false, partial: !!x.partial, at: x.at || new Date().toISOString() }))
}
function loadAskLog(saved) {
  return (Array.isArray(saved) ? saved : []).filter((x) => x && typeof x.q === 'string' && typeof x.a === 'string')
    .map((x) => ({ n: ++askSeq, q: x.q, a: x.a, sources: Array.isArray(x.sources) ? x.sources : [], found: x.found !== false, partial: !!x.partial, at: x.at, loading: false }))
}
function conversationText() {
  const log = (draft?.askLog || []).filter(isFinished)
  if (!log.length) return ''
  return ['Questions and answers', log.map((x) => `- Q: ${x.q}\n  A: ${x.a}${x.sources?.length ? `\n  Heard at: ${x.sources.join(', ')}` : ''}`).join('\n')].join('\n\n')
}
function renderAskPane() {
  const log = draft?.askLog || []
  $('noteTakerAskLog').innerHTML = log.map(askItemHtml).join('')
  $('noteTakerAskSuggest').innerHTML = log.length ? '' : ASK_SUGGESTIONS.map((q) => `<button class="note-taker-chip-btn" type="button" data-q="${escapeHtml(q)}">${escapeHtml(q)}</button>`).join('')
  updateAskUi()
}
function disarmClear() { clearTimeout(clearArmed); clearArmed = null; const b = $('noteTakerAskClear'); if (b) b.innerHTML = '<i class="ph ph-trash"></i> Clear conversation' }
// Two taps, like Delete. The cleared conversation is saved too, so it does not come back when the note is reopened.
function clearConversation() {
  if (!draft || asking || !draft.askLog?.length) return
  if (!clearArmed) { $('noteTakerAskClear').innerHTML = '<i class="ph ph-trash"></i> Tap again to clear the conversation'; clearArmed = setTimeout(disarmClear, 4000); return }
  disarmClear()
  draft.askLog = []; draft.liveNote = false
  renderAskPane(); markEdited()
  if (draft.saved) requestSave()
}
// A new answer on a saved note changes it, like a new summary does: mark it changed and save, so nothing is left unsaved.
function answerArrived() { markEdited(); if (draft?.saved) requestSave() }
function updateAskUi() {
  const ready = !!draft && $('noteTakerEditor').value.trim().length >= 40
  const input = $('noteTakerAskInput'), send = $('noteTakerAskSend')
  input.disabled = !ready || asking
  send.disabled = !ready || asking || !input.value.trim()
  send.innerHTML = asking ? '<i class="ph ph-circle-notch"></i>' : 'Ask'; send.classList.toggle('is-busy', asking)
  const hasLog = !!draft?.askLog?.length
  $('noteTakerAskClear').hidden = !hasLog; $('noteTakerAskClear').disabled = asking
  $('noteTakerAskLiveNote').hidden = !(hasLog && draft?.liveNote)
  $('noteTakerAskHint').textContent = !ready ? 'There is not enough transcript to ask about yet.'
    : askQuotaText || (asksPerDay ? `You can ask up to ${asksPerDay} questions a day. Answers come only from this transcript.` : 'Answers come only from this transcript.')
}
const scrollAskEnd = () => $('noteTakerAskLog').lastElementChild?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
async function ask(question) {
  question = (question || '').trim()
  if (!question || asking || !draft || $('noteTakerEditor').value.trim().length < 40) return
  const target = draft, log = (target.askLog ||= [])
  const history = log.filter((x) => x.a && !x.error).slice(-3).map((x) => ({ q: x.q, a: x.a })) // lets "and who owns that?" work
  const item = { n: ++askSeq, q: question, loading: true }
  log.push(item); asking = true; $('noteTakerAskInput').value = ''
  let answered = false
  renderAskPane(); scrollAskEnd()
  try {
    const res = await askNote({ question, transcript: $('noteTakerEditor').value, title: $('noteTakerCompleteTitle').value.trim(), history })
    Object.assign(item, { loading: false, a: res.answer, sources: res.sources || [], found: res.found, partial: res.partial, at: new Date().toISOString() })
    if (res.quota?.limit) askQuotaText = `${Math.max(0, res.quota.limit - res.quota.used)} of ${res.quota.limit} questions left today.`
    answered = true
  } catch (e) { Object.assign(item, { loading: false, error: e.message || 'Could not answer that right now.' }) }
  asking = false
  if (draft === target) { renderAskPane(); scrollAskEnd() } else updateAskUi()
  if (answered && draft === target && target.askLog?.includes(item)) answerArrived()
}
// ---------- Ask during a live recording ----------
// A side panel over the live transcript. It only reads what has been transcribed so far and calls the same endpoint as
// the Ask tab, so it never touches the microphone, the recognizer or the timer, and it works while paused. The
// conversation is carried into the saved note's Ask tab when the recording finishes (see stopNow).
const LIVE_PROMPTS = [
  { label: 'Catch me up', ask: 'Catch me up: briefly summarize what has been discussed so far, in the order it came up.' },
  { label: 'What has been decided so far?', ask: 'What has been decided so far?' },
  { label: 'Which questions are still unanswered?', ask: 'Which questions are still unanswered?' },
]
const LIVE_ASK_MIN = 40 // matches note-ask-endpoint.js
const liveAskAllowed = () => ['recording', 'paused', 'degraded', 'error'].includes(state) // not while starting or finishing
// The same text the finished note will have: "[time] Speaker N: words", labels only when render() shows them. Words
// still being recognized (the grey interim text) are left out.
function liveTranscript() {
  const multi = multiSpeaker()
  return segments.map((x) => `[${x.time}] ${multi && x.speaker != null ? `${speakerLabel(x.speaker)}: ` : ''}${x.text}`).join('\n\n')
}
function resetLiveAsk() { liveAsk.run++; liveAsk.log = []; liveAsk.asking = false; liveAsk.limitText = ''; liveAsk.unseen = false; closeLiveAsk(false); renderLiveAsk() }
// Called when the recording ends. Returns the conversation for the note: finished answers and any answer still on its
// way. Failed questions stay behind; they were reported where they happened.
function endLiveAsk() {
  const items = liveAsk.log.filter((x) => x.loading || isFinished(x))
  liveAsk.run++; liveAsk.log = []; liveAsk.asking = false; liveAsk.limitText = ''; liveAsk.unseen = false
  closeLiveAsk(false); renderLiveAsk()
  return items
}
function renderLiveAsk() {
  const log = liveAsk.log
  $('noteTakerLiveAskLog').innerHTML = log.length ? log.map(askItemHtml).join('') : '<p class="note-live-ask-empty">Ask about what has been said so far. Recording carries on while you ask.</p>'
  $('noteTakerLiveAskPrompts').innerHTML = LIVE_PROMPTS.map((x, i) => `<button class="note-taker-chip-btn" type="button" data-prompt="${i}">${escapeHtml(x.label)}</button>`).join('')
  updateLiveAskUi()
}
function updateLiveAskUi() {
  const ready = liveAskAllowed() && liveTranscript().trim().length >= LIVE_ASK_MIN
  const off = !ready || !!liveAsk.limitText || liveAsk.asking
  const input = $('noteTakerLiveAskInput'), send = $('noteTakerLiveAskSend')
  input.disabled = off; send.disabled = off || !input.value.trim()
  send.innerHTML = liveAsk.asking ? '<i class="ph ph-circle-notch"></i>' : 'Ask'; send.classList.toggle('is-busy', liveAsk.asking)
  for (const b of $('noteTakerLiveAskPrompts').children) b.disabled = off
  const hint = liveAsk.limitText ? liveAsk.limitText
    : !ready ? 'Not enough has been said yet. Try again in a moment.'
    : askQuotaText || (asksPerDay ? `You can ask up to ${asksPerDay} questions a day. Answers come only from what has been transcribed so far.` : 'Answers come only from what has been transcribed so far.')
  const box = $('noteTakerLiveAskHint'); box.textContent = hint; box.dataset.limit = String(!!liveAsk.limitText)
  $('noteTakerLiveAsk').dataset.unseen = String(liveAsk.unseen && !liveAsk.open)
  $('noteTakerLiveAsk').disabled = !(liveAskAllowed() || state === 'connecting')
}
const scrollLiveAskEnd = () => $('noteTakerLiveAskLog').lastElementChild?.scrollIntoView({ block: 'nearest', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' })
function openLiveAsk() {
  if (!liveAskAllowed() && state !== 'connecting') return
  liveAsk.open = true; liveAsk.unseen = false
  $('noteTakerLiveAskPanel').hidden = false; $('noteTakerLiveAskWrap').dataset.open = 'true'
  $('noteTakerLiveAsk').setAttribute('aria-expanded', 'true')
  renderLiveAsk(); scrollLiveAskEnd()
  ;($('noteTakerLiveAskInput').disabled ? $('noteTakerLiveAskClose') : $('noteTakerLiveAskInput')).focus()
}
function closeLiveAsk(returnFocus = true) {
  const wasOpen = liveAsk.open
  liveAsk.open = false
  $('noteTakerLiveAskPanel').hidden = true; $('noteTakerLiveAskWrap').dataset.open = 'false'
  $('noteTakerLiveAsk').setAttribute('aria-expanded', 'false')
  if (wasOpen && returnFocus) $('noteTakerLiveAsk').focus()
}
async function liveAskSend(label, text = label) {
  label = (label || '').trim(); text = (text || '').trim()
  // One request at a time: the flag is set before anything is awaited, so a double tap cannot send two.
  if (!label || liveAsk.asking || liveAsk.limitText || !liveAskAllowed()) return
  const transcript = liveTranscript()
  if (transcript.trim().length < LIVE_ASK_MIN) return updateLiveAskUi()
  const run = liveAsk.run, log = liveAsk.log
  const history = log.filter(isFinished).slice(-3).map((x) => ({ q: x.q, a: x.a }))
  const item = { n: ++askSeq, q: label, text, loading: true }
  log.push(item); liveAsk.asking = true; $('noteTakerLiveAskInput').value = ''
  renderLiveAsk(); scrollLiveAskEnd()
  let answered = false
  try {
    const res = await askNote({ question: text, transcript, title: $('noteTakerMeetingTitle').value.trim(), history })
    Object.assign(item, { loading: false, a: res.answer, sources: res.sources || [], found: res.found, partial: res.partial, at: new Date().toISOString() })
    answered = true
    if (res.quota?.limit) {
      askQuotaText = `${Math.max(0, res.quota.limit - res.quota.used)} of ${res.quota.limit} questions left today.`
      if (res.quota.used >= res.quota.limit && liveAsk.run === run) liveAsk.limitText = `That was your last question for today. It resets at midnight UTC. Questions you asked are kept with the note.`
    }
  } catch (e) {
    Object.assign(item, { loading: false, error: e.message || 'Could not answer that right now.' })
    if (e.status === 429 && liveAsk.run === run) liveAsk.limitText = e.message || 'You have used all your meeting questions for today. It resets at midnight UTC.'
  }
  liveAnswerArrived(item, run, answered)
}
function liveAnswerArrived(item, run, answered) {
  if (liveAsk.run === run) { // the meeting is still going
    liveAsk.asking = false
    const refocus = liveAsk.open && (document.activeElement === document.body || $('noteTakerLiveAskPanel').contains(document.activeElement))
    if (!liveAsk.open) liveAsk.unseen = true
    renderLiveAsk(); if (liveAsk.open) scrollLiveAskEnd()
    if (refocus && !$('noteTakerLiveAskInput').disabled) $('noteTakerLiveAskInput').focus()
    return
  }
  // The recording ended while this was loading. The question was moved into the note, so the answer lands there.
  const owner = item.owner; delete item.owner
  if (!owner) return // it was never carried over (a new recording started): nothing on screen belongs to it
  asking = false
  if (draft !== owner || !owner.askLog.includes(item)) return // the person has opened another note: nothing to update
  renderAskPane()
  if (answered) answerArrived()
}
// Tapping "Heard at 00:12:03" scrolls the live transcript to that line. The panel covers the transcript, so it closes.
function jumpLive(stamp) {
  closeLiveAsk(false)
  const k = segments.findIndex((x) => x.time === stamp)
  const row = k >= 0 ? $('noteTakerTranscript').children[k] : null
  if (row) {
    row.scrollIntoView({ block: 'center', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' })
    row.classList.add('is-flash'); setTimeout(() => row.classList.remove('is-flash'), 1800)
  }
  $('noteTakerLiveAsk').focus()
}

// Jump from an answer (or a comparison) to the exact line, and play it when there is audio.
function jumpTo(stamp) {
  setView('transcript'); if (editing) setEditing(false)
  renderReader()
  const k = lines.findIndex((l) => l.time === stamp); if (k < 0) return
  const row = $('noteTakerReader').children[k]
  row.scrollIntoView({ block: 'center', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' })
  row.classList.add('is-flash'); setTimeout(() => row.classList.remove('is-flash'), 1800)
  if (audioAvailable() && lines[k].sec != null) playAt(lines[k].sec)
}

// ---------- Recurring meetings ----------
function renderCompare() {
  const el = $('noteTakerCompare')
  if (!el || !draft?.summary) return
  const c = draft.compare, head = '<h4>Since the last meeting</h4>'
  const bar = (w) => `<span class="sk sk-block" style="width:${w}"></span>`
  if (!draft.saved || draft.dirty) { el.innerHTML = `${head}<p class="note-compare-hint">${draft.saved ? 'Save your changes first, so the comparison uses this version.' : 'Save this note first. Recurring meetings are matched by title, so give each one the same name.'}</p>`; return }
  if (!c) { el.innerHTML = `${head}<p class="note-compare-hint">For a meeting that repeats, see what was finished, what is still open and what is new.</p><button class="note-taker-secondary" id="noteTakerCompareGo" type="button"><i class="ph ph-arrows-left-right"></i> Compare with the previous meeting</button>`; $('noteTakerCompareGo').addEventListener('click', runCompare); return }
  if (c.loading) { el.innerHTML = `${head}<div role="status" aria-label="Comparing meetings"><p class="note-compare-hint">${bar('58%')}</p><ul class="note-actions">${['74%', '60%', '68%'].map((w) => `<li>${bar(w)}<small>${bar('40%')}</small></li>`).join('')}</ul></div>`; return }
  if (c.error) { el.innerHTML = `${head}<p class="note-compare-hint is-error">${escapeHtml(c.error)}</p><button class="note-taker-ghost" id="noteTakerCompareGo" type="button"><i class="ph ph-arrow-clockwise"></i> Try again</button>`; $('noteTakerCompareGo').addEventListener('click', runCompare); return }
  const d = c.data
  if (!d.previous) { el.innerHTML = `${head}<p class="note-compare-hint">No earlier meeting with a matching title was found. Dates and numbers in titles are ignored, so "Weekly sync 12 Sep" and "Weekly sync 19 Sep" match.</p>`; return }
  const item = (t) => `<li><span>${escapeHtml(t.task)}</span>${t.owner || t.due ? `<small>${[t.owner, t.due].filter(Boolean).map(escapeHtml).join(', ')}</small>` : ''}${t.evidence ? `<small class="note-compare-why">${escapeHtml(t.evidence)}${t.at ? ` <button class="note-src" type="button" data-at="${t.at}">${t.at}</button>` : ''}</small>` : ''}</li>`
  const group = (title, items) => (items.length ? `<h5>${title} <span>${items.length}</span></h5><ul class="note-actions">${items.map(item).join('')}</ul>` : '')
  const by = (s) => d.items.filter((t) => t.status === s)
  const finished = by('done').filter((t) => t.key)
  const empty = !d.items.length && !d.newItems.length
  el.innerHTML = `${head}<p class="note-compare-hint">Compared with "${escapeHtml(d.previous.title)}", ${fmtDate(d.previous.createdAt)}.${d.alreadyDone ? ` ${d.alreadyDone} earlier task${d.alreadyDone === 1 ? ' was' : 's were'} already ticked off.` : ''}</p>`
    + (empty ? '<p class="note-compare-hint">There was nothing outstanding from last time, and no new action items.</p>' : '')
    + group('Completed', by('done')) + group('Still open', by('open')) + group('Not discussed', by('unknown')) + group('New action items', d.newItems)
    + (finished.length ? `<button class="note-taker-ghost" id="noteTakerCompareMark" type="button"><i class="ph ph-check-square"></i> Tick ${finished.length === 1 ? 'it' : `these ${finished.length}`} off in the earlier meeting</button>` : '')
    + '<p class="note-compare-hint">Matched from the transcripts by AI. Check anything important.</p>'
  $('noteTakerCompareMark')?.addEventListener('click', async (e) => {
    const b = e.currentTarget; b.disabled = true
    try { await setTasksDone(d.previous.id, finished.map((t) => t.key), true); savedNotes = null; b.innerHTML = '<i class="ph ph-check"></i> Ticked off' }
    catch (err) { b.disabled = false; b.textContent = err.message || 'Could not update. Try again.' }
  })
}
async function runCompare() {
  const target = draft; if (!target?.saved || target.compare?.loading) return
  target.compare = { loading: true }; renderCompare()
  try {
    const data = await compareNote(target.id)
    target.compare = { data }
    if (data.quota?.limit) askQuotaText = `${Math.max(0, data.quota.limit - data.quota.used)} of ${data.quota.limit} questions left today.`
  } catch (e) { target.compare = { error: e.message || 'Could not compare these meetings.' } }
  if (draft === target) renderCompare()
}

// ---------- Tasks across all meetings ----------
function allTasks() {
  return (savedNotes || []).flatMap((n) => (n.tasks || []).map((t) => ({ ...t, noteId: n.id, noteTitle: n.title, when: n.createdAt, done: (n.doneTasks || []).includes(t.key) })))
}
function tasksSkeleton() {
  const row = '<li class="task-row" aria-hidden="true"><span class="sk task-box"></span><span class="task-main"><span class="sk sk-block" style="width:72%"></span><small><span class="sk" style="width:120px"></span></small></span></li>'
  return `<div role="status" aria-label="Loading tasks"><section class="task-group"><h4 class="task-note"><span class="sk" style="width:180px"></span></h4><ul class="task-list">${row.repeat(3)}</ul></section><section class="task-group"><h4 class="task-note"><span class="sk" style="width:140px"></span></h4><ul class="task-list">${row.repeat(2)}</ul></section></div>`
}
function renderTasks() {
  const list = $('noteTakerTasksList'); if (!list) return
  const badge = $('noteTakerTaskCount')
  if (!savedNotes) { badge.hidden = true; list.innerHTML = savedLoading ? tasksSkeleton() : savedFailed ? '<div class="note-taker-empty"><p>Your tasks could not be loaded. Nothing has changed.</p><button class="note-taker-secondary" id="noteTakerTasksRetry" type="button">Try again</button></div>' : tasksSkeleton(); return }
  const all = allTasks(), open = all.filter((t) => !t.done), done = all.filter((t) => t.done)
  badge.hidden = !open.length; badge.textContent = String(open.length)
  $('noteTakerTaskOpenCount').textContent = String(open.length); $('noteTakerTaskDoneCount').textContent = String(done.length)
  $('noteTakerTaskOpen').setAttribute('aria-selected', String(taskFilter === 'open')); $('noteTakerTaskDone').setAttribute('aria-selected', String(taskFilter === 'done'))
  const owners = [...new Set(all.map((t) => t.owner).filter(Boolean))].sort((a, b) => a.localeCompare(b))
  if (taskOwner && taskOwner !== '__none' && !owners.includes(taskOwner)) taskOwner = ''
  const sel = $('noteTakerTaskOwner')
  sel.innerHTML = `<option value="">Everyone</option>${owners.map((o) => `<option value="${escapeHtml(o)}">${escapeHtml(o)}</option>`).join('')}${all.some((t) => !t.owner) ? '<option value="__none">No owner</option>' : ''}`
  sel.value = taskOwner
  const shown = (taskFilter === 'open' ? open : done).filter((t) => !taskOwner || (taskOwner === '__none' ? !t.owner : t.owner === taskOwner))
  const pending = savedNotes.some((n) => n.hasSummary && n.tasks === null)
  if (!shown.length) {
    const none = !all.length
    list.innerHTML = `<div class="note-taker-empty"><p>${none ? 'No action items yet.' : taskFilter === 'open' ? (taskOwner ? 'Nothing open for this person.' : 'Nothing left to do.') : 'Nothing has been ticked off yet.'}</p><p class="note-empty-sub">${none ? 'Summarize a meeting and save it. Its action items show up here, and each one links back to the meeting it came from.' : taskFilter === 'open' ? 'Tasks you tick off move to Done.' : 'Tick a task on the Open list and it moves here.'}</p></div>${pending ? '<p class="note-taker-hint">Some older notes are still being indexed. Open this tab again in a moment.</p>' : ''}`
    return
  }
  const groups = []
  for (const t of shown) { let g = groups.find((x) => x.id === t.noteId); if (!g) groups.push((g = { id: t.noteId, title: t.noteTitle, when: t.when, items: [] })); g.items.push(t) }
  const meta = (t) => [t.owner, t.due, t.priority === 'high' ? 'High priority' : ''].filter(Boolean).map(escapeHtml).join(', ')
  list.innerHTML = groups.map((g) => `<section class="task-group"><button class="task-note" type="button" data-open="${escapeHtml(g.id)}">${escapeHtml(g.title)}<small>${fmtDate(g.when)}</small></button><ul class="task-list">${g.items.map((t) => `<li class="task-row"><label><input type="checkbox" data-note="${escapeHtml(t.noteId)}" data-key="${escapeHtml(t.key)}"${t.done ? ' checked' : ''}><span class="task-main"><span class="task-text">${escapeHtml(t.task)}</span>${meta(t) ? `<small>${meta(t)}</small>` : ''}</span></label></li>`).join('')}</ul></section>`).join('')
    + (pending ? '<p class="note-taker-hint">Some older notes are still being indexed. Open this tab again in a moment.</p>' : '')
}
async function toggleTask(noteId, key, done) {
  const n = savedNotes?.find((x) => x.id === noteId); if (!n) return
  const before = [...(n.doneTasks || [])]
  n.doneTasks = done ? [...new Set([...before, key])] : before.filter((k) => k !== key)
  $('noteTakerTasksError').hidden = true; renderTasks()
  try { const res = await setTasksDone(noteId, [key], done); n.doneTasks = res.doneTasks || n.doneTasks }
  catch (e) { n.doneTasks = before; const err = $('noteTakerTasksError'); err.textContent = `${e.message || 'Could not update that task.'} It was put back.`; err.hidden = false }
  renderTasks()
}
function showTasksTab() {
  show('tasks'); $('noteTakerTasksError').hidden = true
  loadSaved(savedNotes === null); renderTasks()
}

// ---------- Wiring ----------
$('noteTakerViewSummary').addEventListener('click', () => setView('summary'))
$('noteTakerViewTranscript').addEventListener('click', () => setView('transcript'))
$('noteTakerViewAsk').addEventListener('click', () => { setView('ask'); if (matchMedia('(pointer: fine)').matches) $('noteTakerAskInput').focus() })
$('noteTakerTabTasks').addEventListener('click', showTasksTab)
$('noteTakerEditToggle').addEventListener('click', () => setEditing(!editing))
$('noteTakerDeleteAudio').addEventListener('click', deleteAudio)
$('noteTakerLabelSpeakers').addEventListener('change', (e) => { try { localStorage.setItem(LABEL_PREF_KEY, e.target.checked ? '1' : '0') } catch {} })
$('noteTakerKeepAudio').addEventListener('change', (e) => { try { localStorage.setItem(AUDIO_PREF_KEY, e.target.checked ? '1' : '0') } catch {} })

$('noteTakerReader').addEventListener('click', (e) => {
  const chip = e.target.closest('.spk'); if (chip) return $('noteTakerSpkMenu')?.dataset.i === chip.dataset.i ? closeSpeakerMenu() : openSpeakerMenu(chip)
  const menu = e.target.closest('#noteTakerSpkMenu')
  if (menu) {
    const b = e.target.closest('button[data-act]'); if (!b) return
    const i = Number(menu.dataset.i)
    if (b.dataset.act === 'assign') assignSpeaker(i, b.dataset.name)
    else if (b.dataset.act === 'new') assignSpeaker(i, nextSpeakerName())
    return
  }
  closeSpeakerMenu()
  const t = e.target.closest('.note-line-time[data-sec]'); if (t) return playAt(Number(t.dataset.sec))
  const txt = e.target.closest('.note-line-text.is-seekable')
  if (txt && !String(getSelection()).trim()) { const l = lines[Number(txt.closest('.note-line').dataset.i)]; if (l?.sec != null) playAt(l.sec) }
})
$('noteTakerReader').addEventListener('submit', (e) => { e.preventDefault(); const f = e.target.closest('.note-spk-rename'); if (f) renameSpeaker(f.dataset.old, f.querySelector('input').value) })
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && $('noteTakerSpkMenu')) { e.stopPropagation(); closeSpeakerMenu() } }, true)
document.addEventListener('click', (e) => { if ($('noteTakerSpkMenu') && !e.target.closest('.note-line-body')) closeSpeakerMenu() })

$('noteTakerAudioPlay').addEventListener('click', togglePlay)
$('noteTakerAudioSpeed').addEventListener('click', () => { speedIdx = (speedIdx + 1) % SPEEDS.length; audio.playbackRate = SPEEDS[speedIdx]; $('noteTakerAudioSpeed').textContent = `${SPEEDS[speedIdx]}x` })
const seekBar = $('noteTakerAudioSeek')
seekBar.addEventListener('pointerdown', () => { dragging = true })
seekBar.addEventListener('input', () => { const d = audioDuration(); if (audioUrl && d) audio.currentTime = (Number(seekBar.value) / 1000) * d; syncAudioBar() })
seekBar.addEventListener('change', () => { dragging = false; syncPlayhead() })
for (const ev of ['timeupdate', 'play', 'pause', 'ended', 'durationchange']) audio.addEventListener(ev, syncPlayhead)

$('noteTakerAskSend').addEventListener('click', () => ask($('noteTakerAskInput').value))
$('noteTakerAskInput').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); ask(e.target.value) } })
$('noteTakerAskInput').addEventListener('input', updateAskUi)
$('noteTakerPaneAsk').addEventListener('click', (e) => {
  const q = e.target.closest('[data-q]'); if (q) return ask(q.dataset.q)
  const r = e.target.closest('[data-retry]'); if (r) { const log = draft?.askLog || [], k = log.findIndex((x) => String(x.n) === r.dataset.retry); if (k >= 0) { const [gone] = log.splice(k, 1); ask(gone.q) } return }
  const at = e.target.closest('[data-at]'); if (at) jumpTo(at.dataset.at)
})
$('noteTakerSummary').addEventListener('click', (e) => { const at = e.target.closest('.note-src[data-at]'); if (at) jumpTo(at.dataset.at) })
$('noteTakerVoiceBar').addEventListener('click', voiceBarClick)
$('noteTakerVoiceList').addEventListener('click', (e) => { const n = e.target.closest('[data-forget]')?.dataset.forget; if (n) forgetVoiceClick(n) })
$('noteTakerVoicesForget').addEventListener('click', forgetAllClick)
$('noteTakerAskClear').addEventListener('click', clearConversation)
$('noteTakerLiveAsk').addEventListener('click', () => (liveAsk.open ? closeLiveAsk() : openLiveAsk()))
$('noteTakerLiveAskClose').addEventListener('click', () => closeLiveAsk())
$('noteTakerLiveAskSend').addEventListener('click', () => liveAskSend($('noteTakerLiveAskInput').value))
$('noteTakerLiveAskInput').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); liveAskSend(e.target.value) } })
$('noteTakerLiveAskInput').addEventListener('input', updateLiveAskUi)
$('noteTakerLiveAskPanel').addEventListener('click', (e) => {
  const p = e.target.closest('[data-prompt]'); if (p) { const x = LIVE_PROMPTS[Number(p.dataset.prompt)]; if (x) liveAskSend(x.label, x.ask); return }
  const r = e.target.closest('[data-retry]'); if (r) { const k = liveAsk.log.findIndex((x) => String(x.n) === r.dataset.retry); if (k >= 0) { const [gone] = liveAsk.log.splice(k, 1); liveAskSend(gone.q, gone.text || gone.q) } return }
  const at = e.target.closest('[data-at]'); if (at) jumpLive(at.dataset.at)
})
// Escape closes the question panel first; a second press minimizes the note as before.
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && liveAsk.open) { e.stopPropagation(); closeLiveAsk() } }, true)

$('noteTakerTaskOpen').addEventListener('click', () => { taskFilter = 'open'; renderTasks() })
$('noteTakerTaskDone').addEventListener('click', () => { taskFilter = 'done'; renderTasks() })
$('noteTakerTaskOwner').addEventListener('change', (e) => { taskOwner = e.target.value; renderTasks() })
$('noteTakerTasksList').addEventListener('change', (e) => { const c = e.target.closest('input[type="checkbox"][data-key]'); if (c) toggleTask(c.dataset.note, c.dataset.key, c.checked) })
$('noteTakerTasksList').addEventListener('click', (e) => {
  const o = e.target.closest('[data-open]'); if (o) return openSaved(o.dataset.open)
  if (e.target.closest('#noteTakerTasksRetry')) loadSaved(true)
})
