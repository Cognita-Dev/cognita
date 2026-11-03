# Design: real fonts, varied compositions and self-critique (no hosting, no cost)

## What was wrong
- The built-in designer drew every design in system fonts (Arial Black, Helvetica, Georgia). That is the "generic AI look".
- The art direction was a pure hash of the headline, so the same words always got the same composition.
- Nothing scored a design or looked at the result.
- Every background photo prompt ended in the same stock-photo words, so all photos looked alike.

## What changed
- `design-fonts.js` (new): real typefaces embedded INSIDE each SVG design. Nothing is hosted, fetched or uploaded.
  Designs are shown as images, and an SVG used as an image cannot load outside files, so the fonts travel inside it.
  Inter and Inter Display (clean and heavy headlines), Poppins Bold (playful briefs), Lora (serif and italic), all SIL OFL 1.1.
  Cut down to Latin + the naira sign; only the weights a design uses are embedded (about 55-110 KB per design).
  Poppins and Lora have no naira sign, so Inter is embedded for it when a design has one.
- `media-tools.js`
  - Composer uses the embedded fonts; system fonts stay as the fallback.
  - Text-width allowances were measured against the real fonts: headlines are set tighter, body text gets 5% more room.
  - `create_design` takes an optional `seed`. A new request gets a fresh random seed (varied compositions); the seed is
    reported to the model, which passes it back for small edits ("make it bluer") so the composition stays.
  - Background photo prompts vary by tone and seed instead of one fixed stock-photo suffix.
- `design-direction.js`: `seed`, `avoid`, and `stylesForDirection()`.
- `design-critic.js` (new): six compositions are derived and scored by a design lint (contrast, headline length, copy load,
  picture-led layout without a picture); the best is built. The composer then shrinks, trims and re-lays-out until it fits.
  When the optional designer service (doc-studio) is on, the finished picture is also scored by the vision model and
  re-rendered once in another style if it scores below 6/10. Without doc-studio that last step simply does not run.
- `FONT-LICENSES.md`: font credits and licence.
- Tests: `tests/design-critic.test.mjs` (10), `tests/design-fonts.test.mjs` (6).

## What you need to do
Commit these files. That is all: no subdomain, no upload, no new secret, no cost. Workers AI image use is unchanged.

## Research notes (why not something else)
- doc-studio needs a real Chromium inside a container, so it cannot be uploaded as static files like the pyodide host. It stays optional.
- Pollinations' free image API: 768px maximum, one image per 45 seconds per IP, logo on free images. Not usable from a shared Worker.
- In-browser image models (SD-Turbo): a 2.3 GB download and WebGPU only. Not realistic for phones.
- Workers AI free allowance is 10,000 neurons a day, shared by all users. FLUX schnell costs about 58 neurons per 1024px image at 4 steps.

## Known limits
- Checked in headless Chrome (SVG shown as an image, and canvas PNG export) and with fakes. Not run against live Workers AI.
- `tests/docstudio-chat.test.mjs` needs `tests/key.pem`, which is not in the repo (unrelated).
