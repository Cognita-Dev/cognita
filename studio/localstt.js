// studio/localstt.js
// Automatic captions ON THIS DEVICE (Whisper tiny, multilingual, through the isolated model frame). LOCAL: the sound is never sent anywhere,
// there is no plan requirement and no daily allowance. It reuses the chunking and cue building of transcribe.js, so the captions it makes
// look and behave exactly like the ones from the cloud option.

import * as TR from './transcribe.js';
import * as ML from './ml-client.js';

// The language choices of the Captions tab -> Whisper language codes.
export const WHISPER_LANG = { auto: 'auto', 'en-NG': 'en', 'en-GB': 'en', 'en-US': 'en', 'fr-FR': 'fr', 'yo-NG': 'yo', 'ha-NG': 'ha' };
const abortError = () => Object.assign(new Error('Cancelled'), { name: 'AbortError' });

export const deviceSupport = () => ML.mlSupported();

// Returns { cues, skipped, chunks, partial, error, language }. onProgress({ stage, frac, download }).
export async function transcribeClipLocal({ project, clip, hub, lang = 'auto', signal, onProgress = () => {} }) {
  const sup = ML.mlSupported(); if (!sup.ok) throw new Error(sup.reason);
  const chk = TR.canTranscribe(clip, project); if (!chk.ok) throw new Error(chk.reason);
  onProgress({ stage: 'Reading the sound', frac: 0 });
  const { pcm } = await TR.prepareClipAudio(project, clip, hub);
  if (signal && signal.aborted) throw abortError();
  const parts = TR.splitChunks(pcm); const results = []; let skipped = 0, partial = false, error = '', language = '';
  const wl = WHISPER_LANG[lang] || 'auto';
  for (let i = 0; i < parts.length; i++) {
    if (signal && signal.aborted) { partial = true; error = 'Cancelled.'; break; }
    const [a, b] = parts[i];
    if (TR.peakOf(pcm, a, b) < TR.MIN_PEAK) { skipped++; continue; }
    const label = 'Transcribing part ' + (i + 1) + ' of ' + parts.length;
    try {
      const r = await ML.transcribePcm(pcm.subarray(a, b), {
        lang: language && wl === 'auto' ? language : wl, signal, // detect the language once, then keep it for the rest of the clip
        onProgress: (m) => { if (m.work) onProgress({ stage: label, frac: (i + m.loaded) / parts.length }); else onProgress({ stage: m.what || label, frac: i / parts.length, download: m.total ? m.loaded / m.total : 0 }); },
      });
      language = r.language || language; results.push({ offset: a / TR.SR, segments: r.segments || [] });
    } catch (e) {
      if (e && e.name === 'AbortError') { partial = true; error = 'Cancelled.'; break; }
      if (!results.length) throw e;
      partial = true; error = e.message || 'Stopped early.'; break;
    }
  }
  onProgress({ stage: 'Making caption cues', frac: 1 });
  return { cues: TR.buildCues(results, clip, project), skipped, chunks: parts.length, partial, error, language };
}
