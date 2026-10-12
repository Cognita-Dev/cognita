# Cognita Studio (multitrack editor)

Cognita Studio is a client-side video editor. Everything is vanilla ES modules: no bundler, no framework, no inline scripts, no eval, no wasm-unsafe-eval. Footage never leaves the browser. The only network calls are the existing ones (storyboard `/api/chat`, pictures `/api/image`, narration `/api/studio/tts`).

## Status: what was actually run

Everything below was run in headless Chromium with the page's real CSP header, against the real repo files, with ffprobe and ffmpeg checking every exported file. The sandbox has no H.264 encoder, so exports there came out as WebM (VP9 + Opus). The MP4 (H.264) path was run once in the first session (text only, no sound). MP4 with sound is **untested**.

Passed:
- Studio loads with no page errors. An old v1 project migrates and opens as v2.
- Import of a video with sound, placed and exported: one video and one audio stream, right length, audio not silent.
- Image + keyframed text + two transitions + burned-in caption export plays. In/Out range export has the right length. Speed 2x and reverse export with the right length and no errors.
- Undo and redo return the exact state after split, move and delete.
- Duplicate and delete project: copies keep their own media; a file shared by two projects survives until the last one is deleted.
- Automatic captions (see below): 25 browser checks against a fake speech service and 30 Worker checks against the real endpoint, plan and usage code with a fake model.
- Track height by drag (one Undo step), by arrow keys, with a minimum.
- HEVC video gets a plain refusal. A phone video with rotation metadata imports at its display size and exports upright (checked against a reference frame).
- Missing media is flagged, Replace relinks it, and the project exports with sound afterwards. A project JSON imported "on another device" opens with its media flagged missing and can be relinked. A broken JSON file is refused.
- Layout checked by screenshot at 1100x800 and 390x844 (no sideways overflow).

Still **untested**: MP4 with AAC sound, real Whisper output, real phones and touch dragging, 4K, long videos, memory use on big projects, the MediaRecorder fallback, voice-over recording, narration end to end, the Assistant, pictures from `/api/image`, and everything not listed above. The sandbox cannot load the icon font, so icons were not seen.

Bug found and fixed while testing: after **Replace**, the clean-up of unused files ran before the project was saved and deleted the new file. It now saves first.

## Architecture

```
studio.js            mount/activate/deactivate entry, editor shell, autosave status, leave guard
home.js              home screen, library, blank project, JSON import, open and migrate, generate pipeline
model.js             project data model (v2), v1 -> v2 migration, sanitising, storyboard adapters
render.js            drawFrame(ctx, W, H, project, t, res, opts): the one pure renderer
audio.js             scheduleProject(...): the one audio graph, plus peaks, beat detection, decoders
engine.js            v1 renderer kept for legacy scenes (drawSceneCore), narration keys, music synth
media.js             import and probe, Hub (decoded media for preview and export), reverse, scene detect, AI pictures
export.js            planExport (real codec probe), WebCodecs exporter, MediaRecorder fallback
store.js             IndexedDB (projects, assets, recovery, templates)
captions.js          SRT/VTT parse and write
transcribe.js        automatic captions: chunking, upload, words to cues
library-data.js      filters, stickers, text and caption presets, built-in templates
editor/state.js      the one editor state, event bus, command/undo system, every edit operation
editor/preview.js    preview canvas, playback clock, live audio, meter, on-canvas handles
editor/timeline.js   canvas multitrack timeline with DOM track headers, pointer events
editor/library.js    left panel tabs (media, audio, text, stickers, effects, transitions, filters, captions incl. auto-captions, templates)
editor/ai.js        AI tab: storyboard, assistant, pictures, narration
editor/inspector.js  right panel: contextual controls, keyframes, project settings
editor/export-ui.js  export dialog
editor/shortcuts.js  keyboard shortcuts and the cheat sheet
editor/dialog.js     the single modal (Escape, Tab trap, focus return)
editor/util.js       small helpers
```

## Data model (v2)

`{v:2, id, title, settings:{width,height,aspect,fps,bg,preset}, audio:{master,duck:{amount,attack,release}}, assets[], tracks[], clips[], markers[], styles[], captionStyle, export:{burnCaptions}, language, lang, voice, rate, style}`

- Time is in seconds, snapped to the frame rate for display. A clip's source range is `[in, in + duration * speed]`.
- Clip kinds: video, image, audio, music, text, shape, sticker, scene, caption, effect, adjustment.
- A clip has transform (position, scale, rotation, flip, crop, fit, mask), opacity, blend, 10 colour adjustments, a filter, effects, chroma key, in and out transitions, audio settings, and keyframes (`prop -> [{t, v, ease}]`).
- Track roles `main`, `storyboard`, `storyCaptions`, `narration`, `music`, `captions` keep AI storyboard output editable.

## How preview and export share code

Preview, thumbnails and export all call `render.drawFrame` with a resource object (`image`, `frame`, `svg`). Preview feeds it `<video>` and decoded images from the Hub. Export feeds it frames decoded in time order. Sound is built by the same `audio.scheduleProject` for the live preview (AudioContext) and for export (OfflineAudioContext), so a change to the mix cannot make preview and export differ.

One command system: every edit goes through `transact(label, fn, {coalesce})`. Undo stores snapshots of the edit state, capped at 100 commands and 60 million characters. Drags and slider moves coalesce into one command. Autosave runs 900 ms after a change; a recovery copy is written every 8 s while there are unsaved changes.

## Features

LOCAL means it runs in the browser. NEEDS SERVICE means it calls a Cognita Worker endpoint.

| Feature | Where it runs |
|---|---|
| Multitrack timeline: add, move, trim, split, ripple, snap, group, copy and paste, markers, zoom, lock, mute, solo, hide | LOCAL |
| Import video, image, audio (drag and drop or button), thumbnails, waveforms | LOCAL |
| Transform, crop, fit, masks with feather, opacity, blend modes | LOCAL |
| Colour adjustments, filters, effects, adjustment layers, chroma key | LOCAL |
| Text (fonts, outline, shadow, gradient, box), kinetic typography, shapes, stickers, emoji | LOCAL |
| Keyframes, easing, animation presets | LOCAL |
| Speed, reverse (up to 12 s), freeze frame, detach audio | LOCAL |
| Transitions between clips (11 types) | LOCAL |
| Audio: gain, fades, pan, loop, ducking, basic noise reduction, master level meter | LOCAL |
| Voice-over recording, built-in synthesised music, beat markers | LOCAL |
| Captions: manual, SRT/VTT import and export, burn-in on export | LOCAL |
| Templates (4 built in, save your own), saved styles | LOCAL |
| Export MP4 (H.264 + AAC) or WebM, with probing of what the device can encode | LOCAL |
| Project save, duplicate, delete, JSON export and import, recovery | LOCAL |
| AI storyboard from prompt, document, images or footage; the Assistant | NEEDS SERVICE (`/api/chat`) |
| AI pictures | NEEDS SERVICE (`/api/image`) |
| Narration | NEEDS SERVICE (`/api/studio/tts`, Studio plan) |
| Automatic captions (speech to text, Whisper on Workers AI, Studio plan; only sound is sent) | NEEDS SERVICE (`/api/studio/stt`) |
| Background removal | NOT BUILT (disabled row with the reason) |

## Export honesty

`planExport` asks the browser which encoders really work at the chosen size and shows the real container and codec. MP4 is only offered when H.264 and AAC both encode. Otherwise WebM (VP9 or similar plus Opus). If WebCodecs is missing, a real-time MediaRecorder mode is used and labelled as such. The file extension always matches what was written. A WebM file is never named .mp4.

## Keyboard shortcuts

Space play or pause, J/K/L back, pause, play, Left/Right one frame (Shift: one second), Home/End, S split, Delete (Shift: ripple), D duplicate, Ctrl/Cmd+C/V copy and paste, A select all, G group (Shift+G ungroup), M marker, I/O in and out marks, +/- zoom, Shift+Z fit, N snapping, R ripple trim, Ctrl/Cmd+Z undo, Ctrl/Cmd+Shift+Z or Y redo, Ctrl/Cmd+S save, Ctrl/Cmd+E export, ? the cheat sheet.

## Dependencies

Mediabunny 1.61.3 (MPL-2.0), already vendored in `vendor/` with its licence. No new libraries. No API keys. Speech to text uses Cloudflare Workers AI `@cf/openai/whisper-large-v3-turbo` through the existing `AI` binding (the note taker uses the same model).

## Automatic captions (new)

Browser (`transcribe.js`, Captions tab): decodes the sound of the selected clip, keeps only the part on the timeline, resamples to 16 kHz mono, cuts it into chunks of about 25 s (never over 29 s) at the quietest moment, skips silent chunks, sends each as a small WAV to `POST /api/studio/stt` one at a time, then groups the returned words into caption cues (speed and trim are respected) and adds them in one Undo step. Cancel stops after the chunk in flight. If it stops early (limit, error), cues found so far are kept. The control is disabled with a reason when the plan does not allow it, the server is older, or the feature is switched off.

Worker (`server/stt.js`, route in `server/endpoint.js`): verified uid, plan from the server, kill switch, WAV and size checks before anything is counted, reserve the estimated seconds, run Whisper, refund in full on failure, then true up to the length Whisper reports (a client that under-claims the length cannot get cheap audio). Nothing is stored. `/api/studio/status` now also returns a `transcription` block.

**What you must configure**
1. Deploy the Worker (`worker.js`, `entitlements.js`, `studio/server/*`). The `AI` binding and the `COGNITA_USAGE` KV already exist for the note taker and narration.
2. Optional kill switch: Worker variable `STUDIO_STT_DISABLED=1` switches it off without a deploy.
3. Allowance is the new plan limit `studioSttSecondsPerDay` in `entitlements.js`: Free 0, Plus 0, Studio 1800 (30 min of speech per day), Admin unlimited. Change the number there if you want.
4. Cost: Cloudflare lists Whisper large-v3-turbo at about $0.0005 per audio minute. Worst case for one Studio user at the limit is 30 min a day. Confirm the current price in your Cloudflare dashboard.
5. Not verified against the real service: the audio size limit (Cloudflare does not state one; chunks are kept under 1 MB), and how well it handles Nigerian English, Pidgin, Yoruba and Hausa. Always check names in the result.

## Files changed outside `studio/`

- `worker.js`: `/api/studio/stt` gets a 1.5 MB body allowance (other `/api/studio/*` routes stay at 100 KB) and is added to the rate-limited "heavy" routes next to `/api/studio/tts`.
- `entitlements.js`: new limit `studioSttSecondsPerDay` on all four plans. Nothing else changed.
- `.vercelignore`: adds `studio/server/` (Worker only code, the browser never loads it).
- `app.html`, `js/router.js`, `vercel.json`: untouched. The existing CSP is enough (no WebAssembly). The existing narration gating is untouched.

## Migration notes

- Old projects (`scenes[]`) are converted to v2 in memory on open. The stored copy is not changed until you edit. The original is kept inside the new project as `legacyV1`.
- Narration cached under `narr_<key>` stays valid and is reused.
- IndexedDB moves from version 1 to 2 (adds `recovery` and `templates`). The upgrade never deletes data.
- `store.deleteProject` was renamed `deleteProjectAndAssets` and now keeps files other projects still use.

## Limitations

- Background removal is not built. A model that runs in the browser needs WebAssembly, which the site's security policy forbids (it would need `wasm-unsafe-eval` added to `vercel.json`, which is your decision). No Cognita Worker model fits. Chroma key removes a plain green or blue background locally.
- Stabilisation and motion tracking are not built.
- Speed changes pitch (no time-stretch). Preview sound plays only at 1x.
- Undo is snapshot based, so very large projects use more memory per step.
- Two clips of the same video playing at once share one preview frame.
- GIFs show their first frame only.
- Reverse is limited to 12 s clips and a memory budget.
- Noise reduction is a basic filter, not a trained model.
- Automatic captions: Studio plan only, up to the daily allowance, sound only, accuracy not measured on Nigerian languages. Word timing needs the model to return words; otherwise timing is spread across each sentence.
- HEVC video is refused with an explanation where the browser cannot decode it.
- Mobile layout was checked by screenshot only, not on real phones. Touch dragging of the new track-height handle is untested.
- Real-device encoder behaviour is unknown beyond the sandbox (WebM only there).
