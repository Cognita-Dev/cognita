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

### Update: the four features that were left out are now built and tested

Background removal, video stabilisation, motion tracking and speech-to-text that runs on the device. All four run in the browser with no paid service, and **footage and sound are not uploaded**. Details are in "On-device tools" below. What was run (headless Chromium, the real header rules from `vercel.json`, real editor UI, real exported file):

- `node tests/studio-motion.test.mjs`: 12 of 12 passed (stabilisation and tracking maths against synthetic footage with known shake).
- `python3 tests/studio-ml.e2e.py`: 27 of 27 passed (the isolated model frame: Whisper on real speech, the cut-out model on a real photo, the security policy of the frame tested with real scripts, cancel, responsiveness).
- `python3 tests/studio-tools.e2e.py`: 27 of 27 passed (the real Studio: import a shaky video, stabilise, track a point and attach a shape to it, remove the background, make captions, export, check the exported frame; zero CSP violations and zero page errors).

Measured results (one 6.6 s, 640x360, 25 fps test clip with deliberate shake, so treat these as a guide, not a guarantee):

| Feature | Result |
|---|---|
| Stabilisation | Recovered the real camera path to 1.2 px (x) and 1.5 px (y) RMS on a 640 px frame. On the **rendered output**, frame-to-frame jitter fell from 11.95 px to 4.94 px (about 60% less). No border colour showed at the edges. Analysis took a few seconds. |
| Motion tracking | Mean error 1.4 px, worst 3.2 px against the true feature position, never lost. A shape attached to the point, found in the rendered pixels, followed it to within 9.8 canvas px worst case (mean about 5). |
| Background removal | Subject kept, background removed (checked on rendered pixels and in the exported WebM). **Slow: 177 s for 6.6 s of video** (67 frames at about 2.6 s per frame) in the headless test machine. See Limitations. |
| Captions on device | Word error rate 0.0 to 0.056 on two read English recordings. 6.6 s of speech took 9 to 10 s, 16.7 s took 9 s. Silence and quiet noise produced no invented text. |

Still **untested**: MP4 with AAC sound, real output from the cloud Whisper service (Workers AI), real phones and touch dragging, 4K, long videos, memory use on big projects, the MediaRecorder fallback, voice-over recording, narration end to end, the Assistant, pictures from `/api/image`, and everything not listed above. The sandbox cannot load the icon font, so icons were not seen.

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
| Automatic captions, cloud option (Whisper on Workers AI, Studio plan; only sound is sent) | NEEDS SERVICE (`/api/studio/stt`) |
| Automatic captions on this device (Whisper tiny, multilingual, free, no limit, nothing uploaded) | LOCAL |
| Background removal for video and pictures (U²-Net-P) | LOCAL |
| Video stabilisation | LOCAL |
| Motion tracking, with text, stickers, shapes and pictures that follow a tracked point | LOCAL |

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

## On-device tools

Stabilise, Remove background and Track motion are sections in the Inspector of a video clip (Remove background also for pictures); "Follow a tracked point" is in the Inspector of text, stickers, shapes, pictures and captions. Automatic captions on this device is the default mode of the Captions tab; the cloud option is one dropdown away.

### How it works

- **Stabilisation and tracking** are plain JavaScript (`motion.js`, no WebAssembly, no model, no network). Frames are decoded with the already vendored Mediabunny (`analyze.js`). Stabilisation matches a grid of blocks between neighbouring frames (coarse then fine then sub-pixel), reduces them to a robust shift and a small roll (outliers such as a person walking through the shot are discarded), adds them into a camera path, smooths the path with a Gaussian (Strength slider, 0.1 to 2.5 s) and counter-moves each frame. The raw path is stored on the clip (`clip.stab`), so Strength and Crop limit change live without analysing again. Tracking follows a patch with sum of absolute differences and a sub-pixel step, forwards and backwards from the frame the user picked, with a slowly adapting patch and a match test that is relative to the patch's own contrast (so a point that leaves the picture is flagged lost instead of locking onto something else). The track is stored on the clip (`clip.tracks`).
- **Where it is drawn:** `render.js` (the one function used by preview and export). Stabilisation is applied to the picture before the clip transform. A follower's position is read from the tracker through the source clip's crop, fit, stabilisation and transform, so it stays on the point even when the source clip is moved, scaled, rotated, cropped or stabilised. The cut-out is applied as a mask over the same box the picture was drawn in. Because both use `render.js`, preview and export match (checked: the exported frame shows the cut-out).
- **Background removal and Whisper** need a neural network, so they run through ONNX Runtime Web (WebAssembly) inside an isolated frame (below). Whisper: log-mel spectrogram (same maths as OpenAI's), encoder, then greedy decoding with Whisper's timestamp rules, a no-speech check, a repetition guard, and a seek loop for windows the model ends early. Background removal: U²-Net-P on 320x320 pictures; the alpha pictures are stored per sampled frame (`matte.js`) in IndexedDB under `clip.bg.key` and counted in `assetIdsOf`, so they follow the project and are cleaned with it.
- **Saved data** (all optional fields, validated in `sanitiseClip`): `clip.stab`, `clip.bg`, `clip.tracks`, `clip.follow`. Old projects open unchanged.

### Security changes

The task allowed changing the Content-Security-Policy. The narrowest working design was used, and **the main app's CSP was not changed at all** (the test checks that it still has neither `unsafe-eval` nor `wasm-unsafe-eval`).

1. WebAssembly needs `wasm-unsafe-eval`. It is allowed only on one new page, `/studio-ml-frame`, never on the app. That page is excluded from the main CSP rule in `vercel.json` the same way `sandbox-frame` and `preview-frame` already are (two CSP headers would be intersected and would block WebAssembly).
2. The frame's own policy: `sandbox allow-scripts; default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; worker-src blob:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'`.
   - `wasm-unsafe-eval` lets WebAssembly be compiled and nothing else. `eval`, `new Function` and inline scripts stay blocked (tested with real scripts, inside the frame and inside its worker).
   - `sandbox` without `allow-same-origin` gives the frame an opaque origin: no cookies, no localStorage or IndexedDB, no Firebase session, no access to the Cognita page.
   - `connect-src 'self'` means it can fetch only this site's static model files. Footage, sound and results cannot be sent anywhere (tested: a fetch to another site fails, inside the frame and inside its worker).
   - `worker-src blob:` is there so the models run in a Worker, off the main thread. A same-site frame shares the page's thread, and without the worker inference froze the whole editor (found by the cancel test). The worker is started from a blob of `ml-worker.js` and inherits the frame's policy. With the worker, the editor's longest stall during inference was 24 ms.
3. `/studio/ml/(.*)` gets `Access-Control-Allow-Origin: *` and `Cross-Origin-Resource-Policy: cross-origin`, because a sandboxed frame with an opaque origin can read same-site files only with CORS. These are public, static, credential-free files. Cache: 30 days.
4. The iframe is created with `sandbox="allow-scripts"` by `ml-client.js`. A request is accepted only from the parent window and only with a random per-session token; a request with the wrong token is ignored (tested).
5. No new network services, no third-party hosts, no CDN. Everything is vendored in `studio/ml/` with licences (`LICENSES.md`) and checksums (`models/SHA256SUMS`).

### Size and uploading to GitHub

About 98 MB is added to the repo (the models are 4.5 MB + 13 MB + 50 MB, the runtime is 14 MB). Every file is under GitHub's 25 MB web-upload limit: the Whisper decoder is stored as three 16 MiB parts and joined in the browser. Users download the speech model (about 63 MB) only the first time they use on-device captions, and the cut-out model (5 MB) only the first time they remove a background.

### How to re-run the tests

```
node tests/studio-motion.test.mjs
node tests/studio-server.mjs 8765 &
python3 tests/studio-ml.e2e.py
python3 tests/studio-tools.e2e.py     # needs ffmpeg; takes about 6 minutes (the cut-out is slow)
```

## Files changed outside `studio/`

- `worker.js`: `/api/studio/stt` gets a 1.5 MB body allowance (other `/api/studio/*` routes stay at 100 KB) and is added to the rate-limited "heavy" routes next to `/api/studio/tts`.
- `entitlements.js`: new limit `studioSttSecondsPerDay` on all four plans. Nothing else changed.
- `.vercelignore`: adds `studio/server/` (Worker only code, the browser never loads it).
- `app.html`, `js/router.js`: untouched. The existing narration gating is untouched.
- `vercel.json`: **changed, see "Security changes".** The main app's Content-Security-Policy is not changed.
- `studio-ml-frame.html` (new, in the repo root so the header rule can exclude it like the other frames).
- `tests/`: `studio-server.mjs` (static server that applies the `vercel.json` header rules), `studio-ml.e2e.py`, `studio-tools.e2e.py`, `studio-motion.test.mjs`, and small fixtures. `.vercelignore` already keeps `tests/` out of the deployment.

## Migration notes

- Old projects (`scenes[]`) are converted to v2 in memory on open. The stored copy is not changed until you edit. The original is kept inside the new project as `legacyV1`.
- Narration cached under `narr_<key>` stays valid and is reused.
- IndexedDB moves from version 1 to 2 (adds `recovery` and `templates`). The upgrade never deletes data.
- `store.deleteProject` was renamed `deleteProjectAndAssets` and now keeps files other projects still use.

## Limitations

- Background removal is a small general-purpose model (U²-Net-P, 4.5 MB), not a portrait matting model. It finds the main subject well on clear people and objects, but edges are soft and slightly blocky (it works at 320x320), a light fringe can remain, hair and thin straps are approximate, and cluttered scenes or several people can confuse it. The Edge position and Edge softness sliders help.
- Background removal on video is slow: it runs the model on a single thread in WebAssembly. Measured 2.6 s per frame on the test machine, so a 10 s clip at 10 frames per second can take several minutes, and a phone will be slower. Video is limited to 90 s per clip and 360 sampled frames (the sampling rate drops for longer clips); cut-out frames in between are blended. Fast motion can lag the cut-out edge a little. The user can cancel at any time.
- Matte data is about 100 KB per sampled frame (about 4 MB for 10 s) and is kept in the browser's IndexedDB with the project's media.
- Stabilisation corrects shift and slight roll of the whole picture, not rolling-shutter wobble, motion blur, or parallax. It needs texture to lock onto (flat sky or a blank wall gives weak results and the user is told). A crop-in (default cap 130%) hides the borders; past the cap the correction is reduced instead of showing black edges. Limited to 120 s of footage per clip.
- Motion tracking follows a point's position, not its scale or rotation. It follows one small patch of the picture, so it can lose a point that leaves the frame, is hidden, or changes a lot (it then holds the last position and says so). Limited to 90 s per clip and 6 tracks per clip. A clip that follows a point cannot be dragged on the preview; change its Position values, which become offsets from the point.
- Captions on device use Whisper **tiny**, the smallest model, so that the download stays at about 63 MB and phones can run it. It is good on clear English, weaker on accents, noise, names and numbers, and weak on Yoruba and Hausa (not tested here; only English was tested). Segment timing is whole phrases, and words inside a phrase are spread by length as with the cloud option. Sound tags such as [Music] are dropped. The first use downloads the model (kept by the browser for 30 days). The cloud option stays available and is more accurate.
- The on-device models need WebAssembly and about 300 MB of free memory while they run (the frame is removed after 4 idle minutes). If either is missing the buttons explain why and nothing else is affected.
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
