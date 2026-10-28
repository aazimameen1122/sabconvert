# SabConvert — every format, one place. In your browser.

A free all-format file converter that runs **entirely in the browser**.
No server, no upload: files are converted on the visitor's own device with
JavaScript. Close the network tab and watch — nothing leaves the machine.

**Live:** https://aazimameen1122.github.io/sabconvert/ (once deployed — see `deploy.sh`)

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
