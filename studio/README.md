# Cognita Studio (multitrack editor)

Cognita Studio is a client-side video editor. Everything is vanilla ES modules: no bundler, no framework, no inline scripts, no eval, no wasm-unsafe-eval. Footage never leaves the browser. The only network calls are the existing ones (storyboard `/api/chat`, pictures `/api/image`, narration `/api/studio/tts`).

## Status: what was actually run

Three checks were run in headless Chromium with the page's real CSP header applied:

1. `/app.html?view=studio` loads with no uncaught page errors and shows the home screen. Passed.
2. An old scene-based (v1) project migrates and opens in the editor (3 scene clips, v2 model, original kept as `legacyV1`). Passed.
3. A 2 second text clip exports to MP4 (H.264, 1080x1920, 30 fps, 2.0 s) and `ffprobe` and `ffmpeg` read it cleanly. Passed.

Everything else in this file is **untested** (written and syntax checked only). Treat it as untested until you try it. The headless browser has no icon font (CDN blocked in the sandbox), so the visual layout was only glanced at once.

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
library-data.js      filters, stickers, text and caption presets, built-in templates
editor/state.js      the one editor state, event bus, command/undo system, every edit operation
editor/preview.js    preview canvas, playback clock, live audio, meter, on-canvas handles
editor/timeline.js   canvas multitrack timeline with DOM track headers, pointer events
editor/library.js    left panel tabs (media, audio, text, stickers, effects, transitions, filters, captions, templates)
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
| Automatic transcription, background removal | NOT BUILT (disabled rows, would need a service) |

## Export honesty

`planExport` asks the browser which encoders really work at the chosen size and shows the real container and codec. MP4 is only offered when H.264 and AAC both encode. Otherwise WebM (VP9 or similar plus Opus). If WebCodecs is missing, a real-time MediaRecorder mode is used and labelled as such. The file extension always matches what was written. A WebM file is never named .mp4.

## Keyboard shortcuts

Space play or pause, J/K/L back, pause, play, Left/Right one frame (Shift: one second), Home/End, S split, Delete (Shift: ripple), D duplicate, Ctrl/Cmd+C/V copy and paste, A select all, G group (Shift+G ungroup), M marker, I/O in and out marks, +/- zoom, Shift+Z fit, N snapping, R ripple trim, Ctrl/Cmd+Z undo, Ctrl/Cmd+Shift+Z or Y redo, Ctrl/Cmd+S save, Ctrl/Cmd+E export, ? the cheat sheet.

## Dependencies

Mediabunny 1.61.3 (MPL-2.0), already vendored in `vendor/` with its licence. No new libraries. No new Workers. No API keys.

## Files changed outside `studio/`

None. `app.html`, `js/router.js`, `vercel.json`, `entitlements.js` and `studio/server/*` are untouched, so the plan gating is unchanged and the existing CSP is enough (media-src and worker-src already allow blob:).

## Migration notes

- Old projects (`scenes[]`) are converted to v2 in memory on open. The stored copy is not changed until you edit. The original is kept inside the new project as `legacyV1`.
- Narration cached under `narr_<key>` stays valid and is reused.
- IndexedDB moves from version 1 to 2 (adds `recovery` and `templates`). The upgrade never deletes data.
- `store.deleteProject` was renamed `deleteProjectAndAssets` and now keeps files other projects still use.

## Limitations

- Undo is snapshot based, so very large projects use more memory per step.
- Preview sound plays only at 1x. Speeds other than 1x preview the picture only.
- Speed changes pitch (no time-stretch).
- Two clips of the same video playing at once share one preview frame.
- GIFs show their first frame only.
- Reverse is limited to 12 s clips and a memory budget.
- Noise reduction is a basic filter, not a trained model.
- Stabilisation, motion tracking, transcription and background removal are not built.
- HEVC and some phone formats may not decode in every browser. Rotation metadata handling is untested.
- Mobile layout (one pane at a time with a bottom bar) is untested on real phones.
- Real-device encoder behaviour is unknown beyond the one headless run.
