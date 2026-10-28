# SabConvert — every format, one place. In your browser.

A free all-format file converter that runs **entirely in the browser**.
No server, no upload: files are converted on the visitor's own device with
JavaScript. Close the network tab and watch — nothing leaves the machine.

**Live:** https://aazimameen1122.github.io/sabconvert/ (once deployed — see `deploy.sh`)

**Design (v2):** iLovePDF-style flow, from an REA of ilovepdf.com — a
filterable grid of 29 tool cards (each one a real route below), a tool
stage with a big red "Select files" pill, and a dark footer, on brand
red `#e5322d` / `#f5f5fa`. Only the look and flow were adopted: unlike
iLovePDF there is **no server, no upload, no account and no Premium** —
conversion still happens entirely in the visitor's browser. See
`RESULTS.md` ("v2") for what was copied, what was deliberately not
copied (Drive/Dropbox pickers, server processing, Graphik font), and
the harness evidence.

**Form / Exam Mode (v2.1):** the section got a featured header (green
KB tile + red "New!" pill), grouped preset chips (Photo & Signature /
Certificates / Custom) that drive the same preset dropdown, a live
spec card — exact pixels, JPG output, and a KB-window bar showing the
allowed min–max zone — a 1-2-3 steps strip, and a dropzone with the
same big red "Select files" pill as the main stage. A fitted file that
lands inside its window gives its card a green left border next to the
green check line. Presentation and guidance only: the form engine is
untouched. See `RESULTS.md` ("v2.1").

**Quality Mode (v2.2):** "make it 10–20 KB, but the quality must not
drop" — zero loss at any size is physically impossible, so Quality Mode
does the four things that are actually possible, and reports the rest
honestly:

1. **Denoise before encoding** — a 1px-blurred copy is blended back at
   28% (surface-blur lite). Sensor noise costs encoder bytes and adds
   nothing a viewer wants; measured alone on a noisy 400×300 test image
   it shrinks a q0.92 JPEG by **9.5%** (80,137 → 72,495 bytes).
2. **Sharpen after resizing** — when (and only when) a conversion
   actually resizes the image, one 3×3 unsharp convolution (a = 0.2)
   sharpens edges after the resize, restoring the bite resizing takes
   away (skipped above 1600 px, where detail is native). Measured on
   a blurred-boundary edge resized 800×600 → 400×300: steepest step
   50 → 52.
3. **Finer quality-first fitting** — with Quality Mode on, the target-KB
   and form-window searches run extra binary-search iterations, so
   quality is given up last and least.
4. **An honest clean size** — every fit reports the smallest size that
   still counts as clean for that photo (its size at quality 0.82). If
   your target is below it, the result line says so ("Smallest clean
   size for this photo ≈ X KB — this target needed a little less")
   instead of pretending nothing was lost.

5. **A smarter JPEG encoder (v2.3)** — with Quality Mode on, JPGs are
   finished with **MozJPEG** (Mozilla's encoder, Squoosh's WASM build,
   lazy-loaded only when a JPG is actually encoded — Squoosh is
   Apache-2.0, MozJPEG BSD-style). It packs the same pixels with
   optimised Huffman coding and progressive scans. Promised first,
   measured before shipping: configured with the same fidelity choices
   the browser's own encoder makes (4:2:0 subsampling, standard quant
   tables), it came out **9–16% smaller than the browser encoder at
   the same quality number** on photo-like test images, and every
   result that used it says "MozJPEG encoder." (Squoosh's default
   settings measured *larger* than the browser's, so they are not
   what ships — full A/B tables in `RESULTS.md`.) If the encoder
   can't load or fails, the conversion silently falls back to the
   browser encoder; with Quality Mode off, nothing changes at all.

Quality Mode cannot beat physics: below the clean size, softness is
reported, not hidden. It is ON by default in the UI (image cards and
Form Mode), OFF when the engine is called without the flag, and it
never applies to lossless outputs (PNG/BMP/GIF). Why sharpen waits
for a resize, kept honest: measured on synthetic all-noise images,
sharpening an un-resized photo re-amplifies its own noise — the
sharpen step alone added +15.8% bytes at q0.92, more than denoise
saves. So at full size Quality Mode is denoise-only (a noisy 400×300
test image shrinks 8.7%: 80,123 → 73,113 bytes), and sharpen is
reserved for where it pays: after a resize, and in fits — the test
photo fitted to 6 KB came out at 5,867 bytes with QM vs 5,925
without. Full measurements in `RESULTS.md` ("v2.2").

## Run locally

Any static server, no build step:

```bash
cd sabconvert-web
python3 -m http.server 8000
# open http://localhost:8000
```

## What it converts (verified routes only)

The UI only offers routes that pass the automated in-browser harness
(`tests/harness.mjs`, results in `RESULTS.md`). One registry —
`js/routes.js` — drives both the UI and the harness.

| From | To |
|---|---|
| Images (JPG, PNG, WebP, BMP, GIF, AVIF) | JPG, PNG, WebP, BMP, GIF, PDF — plus live preview, quality, exact W×H resize, **fit-to-target-KB**, rotate, grayscale |
| HEIC / HEIF (iPhone photos) | JPG, PNG, WebP, BMP, GIF, PDF — decoded locally by a lazy-loaded WASM decoder, EXIF/irot rotation baked into the pixels |
| PDF | PNG/JPG per page, TXT, split into pages, extract pages → PDF, **compress to a target size**, **merge multiple PDFs** (order numbered on the cards) |
| **Form / Exam Mode** | SSC / IBPS / NEET photo & signature presets + a custom window: crop-to-exact-pixels (never stretched), fitted **inside a two-sided KB window** (minimum too), green check line; JKSSB / NSP certificate presets turn each scan into its own PDF under the cap |
| CSV / TSV / JSON tables | CSV, TSV, JSON, XML, Markdown table, HTML table |
| Text / Markdown / HTML | TXT→HTML, TXT→PDF, MD→HTML, MD→TXT, MD→PDF, HTML→TXT |
| Word (DOCX) | TXT, HTML |
| Subtitles (SRT, VTT, ASS) | each other |
| ZIP | extract files |
| Video (MP4/WebM/MOV the browser can play) | JPG frame, animated GIF |
| Any file | Base64 (.b64) encode + decode, pack into ZIP |

Not in this version (needs heavier engines, not faked): XLSX/PPTX editing,
audio transcoding, EPUB, SVG tracing.
GIF input converts its first frame. DOCX conversion is text/structure level
(paragraphs, headings, bold) — not a pixel-perfect layout clone.
Password-protected PDFs are detected and named in plain words ("remove the
password first") instead of failing with a generic error.

## How it works

- Plain HTML/CSS/JS, **no build step, no runtime CDN**. Libraries are vendored
  in `vendor/`: JSZip (zip + DOCX internals), pdf-lib and pdf.js (PDF create /
  read — lazy-loaded only when a PDF route is picked), gif.js (GIF encoding),
  heic2any (libheif WASM — lazy-loaded only when a HEIC file is dropped).
- Eager page weight ≈ 145 KB; the heavy PDF libraries load on demand.
- Everything is client-side, so it deploys to any static host (GitHub Pages).

## Verify

```bash
cd tests && npm install && node harness.mjs   # needs a local Chrome/Chromium
```

The harness serves the site, generates sample files, runs **every route in
the registry** through the real UI engine in headless Chrome, and asserts
magic bytes, parsing and content survival. `RESULTS.md` is written from a
real run.

## Credit

Inspired by [Filee](https://github.com/KnifeLemon/Filee) (MIT) by KnifeLemon —
an offline desktop converter. SabConvert is an original implementation
(different stack, different code): the shared idea is "every format in one
place, files never leave your device."

## License

MIT
