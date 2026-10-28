'use strict';
/*
 * SabConvert — conversion engine. Every converter takes (file, target, options)
 * and returns a Promise for an array of { name, blob } outputs.
 * All work happens locally in the browser; nothing is uploaded.
 */
(function () {
  const R = window.SC_REGISTRY;
  const loaded = {};
  function loadScript(src) {
    if (loaded[src]) return loaded[src];
    loaded[src] = new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = src; s.onload = () => res(); s.onerror = () => rej(new Error('failed to load ' + src));
      document.head.appendChild(s);
    });
    return loaded[src];
  }
  async function ensurePdfLib() { await loadScript('pdf-lib.min.js'); return window.PDFLib; }
  async function ensurePdfJs() {
    await loadScript('pdf.min.js');
    window.pdfjsLib.GlobalWorkerOptions.workerSrc = 'pdf.worker.min.js';
    return window.pdfjsLib;
  }
  async function ensureGif() { await loadScript('gif.js'); return window.GIF; }

  /* ---------------- HEIC decoding (lazy) ----------------
   * The libheif-based decoder (heic2any, ~1.3 MB) is loaded ONLY when a
   * .heic/.heif file actually arrives; everyone else pays zero bytes.
   * Verified behaviour of this decoder build: it applies the container's
   * irot rotation while decoding, but NOT the EXIF orientation tag — so
   * after decoding we apply EXIF ourselves whenever the file carries no
   * irot rotation of its own (otherwise the photo would rotate twice). */
  async function ensureHeic() {
    await loadScript('heic2any.min.js');
    if (!window.heic2any) throw new Error('HEIC decoder failed to load');
    return window.heic2any;
  }
  const heicCache = new WeakMap(); // File -> Promise<Blob> (decoded PNG)
  function decodeHeicBlob(file) {
    if (!heicCache.has(file)) {
      heicCache.set(file, (async () => {
        try {
          const heic2any = await ensureHeic();
          let outp = await heic2any({ blob: file, toType: 'image/png' });
          if (Array.isArray(outp)) outp = outp[0];
          if (!outp || !outp.size) throw new Error('empty decode');
          return outp;
        } catch (e) {
          throw new Error('This HEIC file couldn’t be decoded — it may use a newer HEIC variant this browser build can’t read yet.');
        }
      })());
    }
    return heicCache.get(file);
  }
  // Walk the ISOBMFF boxes to the irot property; returns its angle in
  // 90° CCW steps (0-3), or null when the file has no irot box.
  function parseHeifIrot(u8) {
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    function walk(start, end, depth) {
      let i = start;
      while (i + 8 <= end) {
        let size = dv.getUint32(i); const type = String.fromCharCode(u8[i + 4], u8[i + 5], u8[i + 6], u8[i + 7]);
        let hdr = 8;
        if (size === 1) { size = Number(dv.getBigUint64(i + 8)); hdr = 16; }
        if (size === 0) size = end - i;
        if (size < hdr || i + size > end + 8) return null;
        if (type === 'irot') return u8[i + hdr] & 3;
        if (depth < 4 && (type === 'meta' || type === 'iprp' || type === 'ipco')) {
          const r = walk(i + hdr + (type === 'meta' ? 4 : 0), i + size, depth + 1);
          if (r !== null) return r;
        }
        i += size;
      }
      return null;
    }
    try { return walk(0, u8.length, 0); } catch (e) { return null; }
  }
  // Find the EXIF orientation (tag 274) by locating the TIFF header inside
  // the file and parsing IFD0. The candidate is validated (SHORT, count 1,
  // value 1-8) so random compressed bytes can't produce a false positive.
  function parseExifOrientation(u8) {
    for (let i = 0; i + 8 < u8.length; i++) {
      const le = u8[i] === 0x49 && u8[i + 1] === 0x49 && u8[i + 2] === 0x2A && u8[i + 3] === 0x00;
      const be = u8[i] === 0x4D && u8[i + 1] === 0x4D && u8[i + 2] === 0x00 && u8[i + 3] === 0x2A;
      if (!le && !be) continue;
      try {
        const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
        const rd16 = (o) => le ? dv.getUint16(o, true) : dv.getUint16(o, false);
        const rd32 = (o) => le ? dv.getUint32(o, true) : dv.getUint32(o, false);
        const ifd = i + rd32(i + 4);
        if (ifd + 2 > u8.length) continue;
        const n = rd16(ifd);
        if (n > 64) continue;
        for (let k = 0; k < n; k++) {
          const e = ifd + 2 + k * 12;
          if (e + 12 > u8.length) break;
          if (rd16(e) === 274 && rd16(e + 2) === 3 && rd32(e + 4) === 1) {
            const v = rd16(e + 8);
            if (v >= 1 && v <= 8) return v;
          }
        }
      } catch (err) { /* keep scanning */ }
    }
    return null;
  }
  // Draw src onto a canvas with the EXIF orientation transform baked in.
  function applyOrientation(src, o) {
    const w = src.width, h = src.height;
    const swap = o >= 5 && o <= 8;
    const cv = document.createElement('canvas'); cv.width = swap ? h : w; cv.height = swap ? w : h;
    const ctx = cv.getContext('2d');
    switch (o) {
      case 2: ctx.transform(-1, 0, 0, 1, w, 0); break;
      case 3: ctx.transform(-1, 0, 0, -1, w, h); break;
      case 4: ctx.transform(1, 0, 0, -1, 0, h); break;
      case 5: ctx.transform(0, 1, 1, 0, 0, 0); break;
      case 6: ctx.transform(0, 1, -1, 0, h, 0); break;
      case 7: ctx.transform(0, -1, -1, 0, h, w); break;
      case 8: ctx.transform(0, -1, 1, 0, 0, w); break;
      default: ctx.drawImage(src, 0, 0); return cv;
    }
    ctx.drawImage(src, 0, 0);
    return cv;
  }
  // The one decode entry point for every image route: HEIC files go through
  // the lazy decoder (+ EXIF fix-up); everything else uses createImageBitmap
  // with EXIF orientation honoured ('from-image').
  async function decodeImageBitmap(file) {
    if (R.classify(file) === 'heic') {
      const png = await decodeHeicBlob(file);
      const bmp = await createImageBitmap(png);
      const u8 = new Uint8Array(await file.arrayBuffer());
      if (!parseHeifIrot(u8)) {
        const ori = parseExifOrientation(u8);
        if (ori && ori !== 1) { const cv = applyOrientation(bmp, ori); bmp.close && bmp.close(); return cv; }
      }
      return bmp;
    }
    try { return await createImageBitmap(file, { imageOrientation: 'from-image' }); }
    catch (e) { return await createImageBitmap(file); }
  }
  // What a card preview should display: the file itself, except HEIC, whose
  // decoded PNG is the only thing a browser <img> can show everywhere.
  async function previewSource(file) {
    return R.classify(file) === 'heic' ? decodeHeicBlob(file) : file;
  }

  /* ---------------- legibility guard ----------------
   * Documented floor: an image fit is flagged 'low' when it had to encode
   * JPEG below quality 0.55 or downscale below 50% of the source pixels.
   * PDF compress has its own rule at its call site (render scale < 1.4 —
   * about 100 DPI against the ~150 DPI legibility floor — or quality
   * < 0.5). The flag only ever produces a warning — never a block. */
  function legibilityOf(quality, scale) {
    if (quality != null && quality < 0.55) return 'low';
    if (scale != null && scale < 0.5) return 'low';
    return 'ok';
  }

  const baseName = (name) => String(name || 'file').replace(/\.[^.]*$/, '');
  const out = (file, suffix, blob) => ({ name: baseName(file.name) + suffix, blob });
  const MIME = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp', bmp: 'image/bmp', gif: 'image/gif',
    pdf: 'application/pdf', txt: 'text/plain', html: 'text/html', json: 'application/json', csv: 'text/csv',
    xml: 'application/xml', zip: 'application/zip' };

  /* ---------------- images (Canvas) ---------------- */
  // Draws a decoded bitmap to a canvas honouring the option set:
  // width/height (exact px; one side only keeps aspect), scale factor,
  // maxDim cap, rotate, grayscale. Old option sets behave exactly as before.
  function drawImageCanvas(bmp, o, scale) {
    const rot = parseInt(o.rotate || '0', 10);
    const swap = rot === 90 || rot === 270;
    let w = bmp.width, h = bmp.height;
    const tw = parseInt(o.width || '0', 10), th = parseInt(o.height || '0', 10);
    if (tw > 0 && th > 0) { w = tw; h = th; }
    else if (tw > 0) { h = Math.max(1, Math.round(h * tw / w)); w = tw; }
    else if (th > 0) { w = Math.max(1, Math.round(w * th / h)); h = th; }
    if (scale && scale > 0 && scale !== 1) { w = Math.max(1, Math.round(w * scale)); h = Math.max(1, Math.round(h * scale)); }
    const maxDim = parseInt(o.maxDim || '0', 10);
    if (maxDim > 0) { const m = Math.max(w, h); if (m > maxDim) { const s = maxDim / m; w = Math.round(w * s); h = Math.round(h * s); } }
    const cw = swap ? h : w, ch = swap ? w : h;
    const cv = document.createElement('canvas'); cv.width = cw; cv.height = ch;
    const ctx = cv.getContext('2d');
    if (o.grayscale) ctx.filter = 'grayscale(1)';
    ctx.translate(cw / 2, ch / 2); ctx.rotate(rot * Math.PI / 180);
    ctx.drawImage(bmp, -w / 2, -h / 2, w, h);
    return cv;
  }
  async function imageCanvas(file, o) {
    const bmp = await decodeImageBitmap(file);
    const cv = drawImageCanvas(bmp, o, 1);
    bmp.close && bmp.close();
    return cv;
  }
  async function imageInfo(file) {
    const bmp = await decodeImageBitmap(file);
    const d = { width: bmp.width, height: bmp.height };
    bmp.close && bmp.close();
    return d;
  }
  function canvasBlob(cv, type, q) {
    return new Promise((res, rej) => cv.toBlob(b => b ? res(b) : rej(new Error('canvas encode failed: ' + type)), type, q));
  }
  /* ---------------- Quality Mode enhancement ----------------
   * denoise: composite a 1px-blurred copy over the original at low alpha
   * (surface-blur lite). Sensor noise is high-frequency detail the encoder
   * spends bytes on without adding anything a viewer wants; softening it
   * first makes lossy encodes smaller at the same settings. Browsers that
   * ignore ctx.filter skip this silently.
   * sharpen: one 3×3 unsharp convolution (a = 0.2) restores the edge bite
   * that resizing takes away. Skipped above 1600 px on either side
   * (per-pixel JS cost) — those images keep their detail natively
   * anyway. Alpha is copied through untouched.
   * Rule (measured, see RESULTS.md v2.2): denoise applies on every lossy
   * Quality Mode path, but sharpen ONLY when the output dimensions
   * differ from the source — sharpening an un-resized noisy photo
   * re-amplifies per-pixel noise (+15.8% bytes at q0.92, measured) and
   * buys nothing; after a real resize it restores the edge step (+12%)
   * and fits come out smaller. Callers pass the resize fact in. */
  function denoiseCanvas(cv) {
    try {
      const t = document.createElement('canvas'); t.width = cv.width; t.height = cv.height;
      const tctx = t.getContext('2d');
      let supported = false;
      try { tctx.filter = 'blur(1px)'; supported = tctx.filter === 'blur(1px)'; } catch (e) { /* no filter support */ }
      if (!supported) return cv;
      tctx.drawImage(cv, 0, 0);
      // Composite on a FRESH canvas and return it: the source canvas's
      // context may carry a leftover translate/rotate from drawImageCanvas,
      // and resetting it with setTransform(a,b,c,d,e,f) throws in some
      // browsers — a fresh context is identity by construction.
      const out = document.createElement('canvas'); out.width = cv.width; out.height = cv.height;
      const octx = out.getContext('2d');
      octx.drawImage(cv, 0, 0);
      octx.globalAlpha = 0.28;
      octx.drawImage(t, 0, 0);
      return out;
    } catch (e) { /* enhancement is best-effort */ }
    return cv;
  }
  function sharpenCanvas(cv) {
    const w = cv.width, h = cv.height;
    if (w > 1600 || h > 1600 || w < 3 || h < 3) return cv;
    try {
      const ctx = cv.getContext('2d');
      const img = ctx.getImageData(0, 0, w, h), src = img.data;
      const outp = new Uint8ClampedArray(src); // alpha (and borders) copied as-is
      const a = 0.2, row = w * 4;
      for (let y = 1; y < h - 1; y++) {
        for (let x = 1; x < w - 1; x++) {
          const i = (y * w + x) * 4;
          for (let c = 0; c < 3; c++) {
            outp[i + c] = src[i + c] * (1 + 4 * a) - a * (src[i - row + c] + src[i + row + c] + src[i - 4 + c] + src[i + 4 + c]);
          }
        }
      }
      ctx.putImageData(new ImageData(outp, w, h), 0, 0);
    } catch (e) { /* best-effort */ }
    return cv;
  }
  function enhanceCanvas(cv, sharpen) { const d = denoiseCanvas(cv); if (sharpen) sharpenCanvas(d); return d; }

  function encodeBMP(cv) {
    const w = cv.width, h = cv.height;
    const img = cv.getContext('2d').getImageData(0, 0, w, h).data;
    const rowSize = Math.floor((24 * w + 31) / 32) * 4;
    const pixSize = rowSize * h, fileSize = 54 + pixSize;
    const buf = new ArrayBuffer(fileSize), dv = new DataView(buf), u8 = new Uint8Array(buf);
    u8[0] = 0x42; u8[1] = 0x4D; // "BM" signature (byte order matters)
    dv.setUint32(2, fileSize, true); dv.setUint32(10, 54, true);
    dv.setUint32(14, 40, true); dv.setInt32(18, w, true); dv.setInt32(22, h, true);
    dv.setUint16(26, 1, true); dv.setUint16(28, 24, true); dv.setUint32(34, pixSize, true);
    for (let y = 0; y < h; y++) {
      const srcY = h - 1 - y;
      for (let x = 0; x < w; x++) {
        const si = (srcY * w + x) * 4, di = 54 + y * rowSize + x * 3;
        u8[di] = img[si + 2]; u8[di + 1] = img[si + 1]; u8[di + 2] = img[si];
      }
    }
    return new Blob([buf], { type: 'image/bmp' });
  }
  async function canvasGif(cv) {
    const GIF = await ensureGif();
    return new Promise((res, rej) => {
      const g = new GIF({ workers: 2, quality: 10, width: cv.width, height: cv.height, workerScript: 'gif.worker.js' });
      g.addFrame(cv, { copy: true, delay: 200 });
      g.on('finished', res); g.on('abort', () => rej(new Error('gif render aborted')));
      g.render();
    });
  }
  // Encode an image so its output is <= targetBytes. JPG/WebP: binary-search
  // quality at the largest size first, then step the scale down. PNG is
  // lossless, so only the scale can shrink it (reported honestly as such).
  // Returns { blob, info } where info.hit says whether the target was met.
  const CLEAN_Q = 0.82; // the quality we call "clean" for honest size reports
  async function fitImage(file, target, o, targetBytes) {
    const bmp = await decodeImageBitmap(file);
    try {
      const mime = MIME[target];
      // Quality Mode enhancement applies to lossy targets only (PNG is
      // lossless — shrinking it is scale-only, reported as before).
      const qm = !!o.qualityMode && (target === 'jpg' || target === 'webp');
      // Sharpen only when this scale step actually resizes (s < 1).
      const mkCanvas = (s) => { const cv = drawImageCanvas(bmp, o, s); return qm ? enhanceCanvas(cv, s < 1) : cv; };
      if (target !== 'png') { // fast path: the normal encode may already fit
        const q0 = o.quality ? Math.min(1, Math.max(0.1, parseFloat(o.quality))) : 0.92;
        const cv0 = mkCanvas(1);
        const b0 = await canvasBlob(cv0, mime, q0);
        if (b0.size <= targetBytes) {
          const cleanBytes = qm ? (await canvasBlob(cv0, mime, CLEAN_Q)).size : null;
          return { blob: b0, info: { targetBytes, achievedBytes: b0.size, hit: true, quality: q0, scale: 1, mode: 'quality', legibility: legibilityOf(q0, 1), qualityMode: qm, cleanBytes } };
        }
      }
      const scales = [1, 0.85, 0.7, 0.55, 0.45, 0.35, 0.27, 0.2, 0.15];
      let best = null;
      const consider = (rec) => { if (!best || rec.blob.size < best.blob.size) best = rec; };
      for (const s of scales) {
        const cv = mkCanvas(s);
        if (target === 'png') {
          const blob = await canvasBlob(cv, 'image/png');
          consider({ blob, scale: s, quality: null });
          if (blob.size <= targetBytes) { best = { blob, scale: s, quality: null, hit: true }; break; }
        } else {
          let lo = 0.05, hi = 0.95, found = null;
          const iters = qm ? 9 : 7; // QM: finer steps — quality is given up last and least
          for (let i = 0; i < iters; i++) {
            const q = (lo + hi) / 2;
            const blob = await canvasBlob(cv, mime, q);
            consider({ blob, scale: s, quality: q });
            if (blob.size <= targetBytes) { found = { blob, scale: s, quality: q, hit: true }; lo = q; } else hi = q;
          }
          if (found) { best = found; break; }
        }
      }
      let cleanBytes = null;
      if (qm) cleanBytes = (await canvasBlob(mkCanvas(best.scale), mime, CLEAN_Q)).size;
      return { blob: best.blob, info: { targetBytes, achievedBytes: best.blob.size, hit: !!best.hit, quality: best.quality, scale: best.scale, mode: target === 'png' ? 'scale' : 'quality+scale', legibility: legibilityOf(best.quality, best.scale), qualityMode: qm, cleanBytes: target === 'png' ? null : cleanBytes } };
    } finally { bmp.close && bmp.close(); }
  }
  // Single-frame GIF fitted under a byte target by stepping the scale down
  // (GIF has no quality knob — 256 colours, dimensions are all we have).
  async function fitGifImage(file, o, targetBytes) {
    const bmp = await decodeImageBitmap(file);
    try {
      const scales = [1, 0.75, 0.55, 0.4, 0.3, 0.2];
      let best = null;
      for (const s of scales) {
        const blob = await canvasGif(drawImageCanvas(bmp, o, s));
        if (!best || blob.size < best.blob.size) best = { blob, scale: s, hit: false };
        if (blob.size <= targetBytes) { best = { blob, scale: s, hit: true }; break; }
      }
      return { blob: best.blob, info: { targetBytes, achievedBytes: best.blob.size, hit: best.hit, quality: null, scale: best.scale, mode: 'gif', legibility: legibilityOf(null, best.scale) } };
    } finally { bmp.close && bmp.close(); }
  }
  async function convImage(file, target, o) {
    const targetKB = parseFloat(o.targetKB || '0');
    if (targetKB > 0 && (target === 'jpg' || target === 'webp' || target === 'png')) {
      const fit = await fitImage(file, target, o, Math.round(targetKB * 1024));
      const r = out(file, '.' + target, fit.blob); r.fit = fit.info;
      return [r];
    }
    if (targetKB > 0 && target === 'gif') {
      const fit = await fitGifImage(file, o, Math.round(targetKB * 1024));
      const r = out(file, '.gif', fit.blob); r.fit = fit.info;
      return [r];
    }
    let cv;
    { const bmp = await decodeImageBitmap(file);
      try { cv = drawImageCanvas(bmp, o, 1);
        // Sharpen only when the drawn size differs from the decoded
        // source size — i.e. the options actually resized the image.
        if (o.qualityMode && (target === 'jpg' || target === 'webp'))
          cv = enhanceCanvas(cv, cv.width !== bmp.width || cv.height !== bmp.height);
      } finally { bmp.close && bmp.close(); } }
    const q = o.quality ? Math.min(1, Math.max(0.1, parseFloat(o.quality))) : 0.92;
    if (target === 'jpg') return [out(file, '.jpg', await canvasBlob(cv, 'image/jpeg', q))];
    if (target === 'png') return [out(file, '.png', await canvasBlob(cv, 'image/png'))];
    if (target === 'webp') return [out(file, '.webp', await canvasBlob(cv, 'image/webp', q))];
    if (target === 'bmp') return [out(file, '.bmp', encodeBMP(cv))];
    if (target === 'gif') return [out(file, '.gif', await canvasGif(cv))];
    throw new Error('unsupported image target ' + target);
  }
  async function convImageToPdf(file, target, o) {
    const { PDFDocument } = await ensurePdfLib();
    const cv = await imageCanvas(file, o);
    const png = await canvasBlob(cv, 'image/png');
    const doc = await PDFDocument.create();
    const img = await doc.embedPng(new Uint8Array(await png.arrayBuffer()));
    const page = doc.addPage([img.width, img.height]);
    page.drawImage(img, { x: 0, y: 0, width: img.width, height: img.height });
    const bytes = await doc.save();
    return [out(file, '.pdf', new Blob([bytes], { type: 'application/pdf' }))];
  }

  /* ---------------- Form / Exam Mode ----------------
   * Image presets: output must land INSIDE a two-sided KB window at exact
   * pixels. The image is centre-cropped to the box's aspect (drag offsets
   * fx/fy in options can reposition it) and resized — never stretched.
   * Strategy: binary-search quality for the LARGEST encode that is still
   * <= max; if that lands under min (sparse images like signatures encode
   * tiny), pad the JPEG up into the window with a COM segment — a comment
   * chunk every decoder skips, so the picture is untouched and the file
   * is still a perfectly valid JPEG. If even the lowest quality overflows
   * max, shrink (only when the preset fixes no dimensions) or fail
   * honestly with the closest size achieved. */
  async function padJpegBlob(blob, targetBytes) {
    if (blob.size >= targetBytes) return { blob, padded: 0 };
    const u8 = new Uint8Array(await blob.arrayBuffer());
    if (u8[0] !== 0xFF || u8[1] !== 0xD8) return { blob, padded: 0 };
    let need = targetBytes - blob.size;
    const chunks = [u8.subarray(0, 2)];
    while (need > 0) {
      let segTotal = Math.min(need, 65535); // marker(2) + length(2) + payload
      if (need - segTotal > 0 && need - segTotal < 4) segTotal -= 4 - (need - segTotal);
      if (segTotal < 4) segTotal = 4;
      const seg = new Uint8Array(segTotal);
      seg[0] = 0xFF; seg[1] = 0xFE; // COM
      seg[2] = (segTotal - 2) >> 8; seg[3] = (segTotal - 2) & 0xFF;
      seg.fill(0x20, 4);
      chunks.push(seg);
      need -= segTotal;
    }
    chunks.push(u8.subarray(2));
    return { blob: new Blob(chunks, { type: 'image/jpeg' }), padded: targetBytes - blob.size };
  }
  function cropToBox(src, tw, th, fx, fy) {
    const ta = tw / th, sa = src.width / src.height;
    let cw, ch;
    if (sa > ta) { ch = src.height; cw = Math.round(ch * ta); } else { cw = src.width; ch = Math.round(cw / ta); }
    cw = Math.min(cw, src.width); ch = Math.min(ch, src.height);
    const x = Math.round((src.width - cw) * (fx == null ? 0.5 : Math.min(1, Math.max(0, fx))));
    const y = Math.round((src.height - ch) * (fy == null ? 0.5 : Math.min(1, Math.max(0, fy))));
    const cv = document.createElement('canvas'); cv.width = tw; cv.height = th;
    cv.getContext('2d').drawImage(src, x, y, cw, ch, 0, 0, tw, th);
    return cv;
  }
  // Largest JPEG encode of cv that is <= maxBytes (binary search on
  // quality). Falls back to the smallest encode when nothing fits.
  async function largestJpegUnder(cv, maxBytes, iters) {
    let best = null, smallest = null;
    let lo = 0.05, hi = 1;
    for (let i = 0; i < (iters || 8); i++) {
      const q = (lo + hi) / 2;
      const blob = await canvasBlob(cv, 'image/jpeg', q);
      if (!smallest || blob.size < smallest.blob.size) smallest = { blob, quality: q };
      if (blob.size <= maxBytes) { if (!best || blob.size > best.blob.size) best = { blob, quality: q }; lo = q; }
      else hi = q;
    }
    return best ? { blob: best.blob, quality: best.quality, hit: true } : { blob: smallest.blob, quality: smallest.quality, hit: false };
  }
  async function formImageFit(file, spec, o) {
    const bmp = await decodeImageBitmap(file);
    try {
      const minBytes = Math.round((spec.minKB || 0) * 1024);
      const maxBytes = Math.round(spec.maxKB * 1024);
      const hasDims = spec.width > 0 && spec.height > 0;
      const qm = !!o.qualityMode;
      const iters = qm ? 10 : 8; // QM: finer steps — quality is given up last and least
      let cv = hasDims ? cropToBox(bmp, spec.width, spec.height, o.cropX, o.cropY)
        : drawImageCanvas(bmp, {}, 1);
      // Crop-to-exact-size counts as a resize -> sharpen; a native-size
      // draw (no fixed box) gets denoise only.
      if (qm) cv = enhanceCanvas(cv, hasDims);
      let enc = await largestJpegUnder(cv, maxBytes, iters);
      let scale = 1;
      if (!enc.hit && !hasDims) { // no fixed size: shrink until it fits
        for (const s of [0.7, 0.5, 0.35, 0.25]) {
          cv = drawImageCanvas(bmp, {}, s); scale = s;
          if (qm) cv = enhanceCanvas(cv, true); // s < 1: a real resize
          enc = await largestJpegUnder(cv, maxBytes, iters);
          if (enc.hit) break;
        }
      }
      // Honest report: what this photo costs at clean quality (0.82) at
      // its final dimensions, after enhancement. One extra encode.
      const cleanBytes = qm ? (await canvasBlob(cv, 'image/jpeg', CLEAN_Q)).size : null;
      let blob = enc.blob, padded = 0;
      if (enc.hit && blob.size < minBytes) {
        const aim = Math.min(maxBytes, minBytes + Math.max(512, Math.round((maxBytes - minBytes) * 0.25)));
        const p = await padJpegBlob(blob, aim);
        blob = p.blob; padded = p.padded;
      }
      const inside = blob.size >= minBytes && blob.size <= maxBytes;
      return { blob, info: { mode: 'window', minBytes, maxBytes, achievedBytes: blob.size, hit: inside && enc.hit,
        quality: enc.quality, scale, padded, width: cv.width, height: cv.height,
        legibility: legibilityOf(enc.quality, scale), qualityMode: qm, cleanBytes } };
    } finally { bmp.close && bmp.close(); }
  }
  // One scanned image -> one PDF under a cap: the image is JPEG-embedded
  // on a page of its own aspect, stepping quality (then scale) down the
  // ladder until the PDF fits. Used by the certificate presets.
  async function certPdfFromImage(file, maxBytes) {
    const { PDFDocument } = await ensurePdfLib();
    const bmp = await decodeImageBitmap(file);
    try {
      const ladder = [[1, 0.85], [1, 0.7], [0.85, 0.65], [0.7, 0.6], [0.55, 0.55], [0.45, 0.5], [0.35, 0.45], [0.28, 0.4]];
      let best = null;
      for (const [s, q] of ladder) {
        const cv = drawImageCanvas(bmp, {}, s);
        const jpg = await canvasBlob(cv, 'image/jpeg', q);
        const doc = await PDFDocument.create();
        const img = await doc.embedJpg(new Uint8Array(await jpg.arrayBuffer()));
        const page = doc.addPage([img.width, img.height]);
        page.drawImage(img, { x: 0, y: 0, width: img.width, height: img.height });
        const blob = new Blob([await doc.save()], { type: 'application/pdf' });
        if (!best || blob.size < best.blob.size) best = { blob, quality: q, scale: s, hit: false };
        if (blob.size <= maxBytes) { best = { blob, quality: q, scale: s, hit: true }; break; }
      }
      return { blob: best.blob, info: { mode: 'cert', minBytes: 0, maxBytes, achievedBytes: best.blob.size, hit: best.hit,
        quality: best.quality, scale: best.scale, pages: 1, legibility: legibilityOf(best.quality, best.scale) } };
    } finally { bmp.close && bmp.close(); }
  }
  // Form Mode entry point. spec: a FORM_PRESETS entry or a custom object
  // of the same shape. opts carries cropX/cropY for image presets.
  async function formFit(file, spec, opts) {
    const o = opts || {};
    const kind = R.classify(file);
    if (spec.type === 'image') {
      if (kind !== 'image' && kind !== 'heic') throw new Error('This preset needs a photo/signature image (JPG, PNG, WEBP or HEIC).');
      const fit = await formImageFit(file, spec, o);
      const r = { name: baseName(file.name) + '-' + spec.id + '.jpg', blob: fit.blob, fit: fit.info };
      return [r];
    }
    // doc presets: every file becomes its OWN PDF under the cap.
    const maxBytes = Math.round(spec.maxKB * 1024);
    if (kind === 'pdf') {
      const res = await convPdfCompress(file, 'compress', { targetKB: String(spec.maxKB) });
      const r = res[0];
      r.name = baseName(file.name) + '-' + spec.id + '.pdf';
      r.fit.mode = 'cert'; r.fit.minBytes = 0; r.fit.maxBytes = maxBytes;
      return [r];
    }
    if (kind === 'image' || kind === 'heic') {
      const fit = await certPdfFromImage(file, maxBytes);
      return [{ name: baseName(file.name) + '-' + spec.id + '.pdf', blob: fit.blob, fit: fit.info }];
    }
    throw new Error('This preset needs a scanned image or a PDF.');
  }

  /* ---------------- PDF ---------------- */
  async function pdfJsDoc(file) {
    const pdfjsLib = await ensurePdfJs();
    const data = new Uint8Array(await file.arrayBuffer());
    return pdfjsLib.getDocument({ data }).promise;
  }
  // First-page thumbnail (JPEG blob) + page count, for card previews.
  async function pdfThumb(file, maxDim) {
    const pdf = await pdfJsDoc(file);
    const page = await pdf.getPage(1);
    const base = page.getViewport({ scale: 1 });
    const cap = maxDim || 360;
    const scale = Math.min(1.5, cap / Math.max(base.width, base.height));
    const vp = page.getViewport({ scale });
    const cv = document.createElement('canvas'); cv.width = Math.max(1, Math.round(vp.width)); cv.height = Math.max(1, Math.round(vp.height));
    const ctx = cv.getContext('2d');
    ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, cv.width, cv.height);
    await page.render({ canvasContext: ctx, viewport: vp }).promise;
    const blob = await canvasBlob(cv, 'image/jpeg', 0.82);
    return { blob, pages: pdf.numPages, width: base.width, height: base.height };
  }
  async function convPdfToImages(file, target) {
    const pdf = await pdfJsDoc(file);
    const mime = target === 'png' ? 'image/png' : 'image/jpeg';
    const results = [];
    for (let p = 1; p <= pdf.numPages; p++) {
      const page = await pdf.getPage(p);
      const vp = page.getViewport({ scale: 2 });
      const cv = document.createElement('canvas'); cv.width = vp.width; cv.height = vp.height;
      await page.render({ canvasContext: cv.getContext('2d'), viewport: vp }).promise;
      const blob = await canvasBlob(cv, mime, 0.92);
      results.push({ name: baseName(file.name) + '-page' + p + '.' + target, blob });
    }
    return results;
  }
  async function convPdfToText(file) {
    const pdf = await pdfJsDoc(file);
    const pages = [];
    for (let p = 1; p <= pdf.numPages; p++) {
      const tc = await (await pdf.getPage(p)).getTextContent();
      let line = '', lastY = null; const lines = [];
      for (const it of tc.items) {
        const y = Math.round(it.transform[5]);
        if (lastY !== null && Math.abs(y - lastY) > 2) { lines.push(line); line = ''; }
        line += (line && !line.endsWith(' ') ? ' ' : '') + it.str; lastY = y;
      }
      if (line) lines.push(line);
      pages.push(lines.join('\n'));
    }
    return [out(file, '.txt', new Blob([pages.join('\n\n')], { type: 'text/plain' }))];
  }
  async function convPdfSplit(file) {
    const { PDFDocument } = await ensurePdfLib();
    const src = await PDFDocument.load(await file.arrayBuffer());
    const results = [];
    for (let i = 0; i < src.getPageCount(); i++) {
      const doc = await PDFDocument.create();
      const [pg] = await doc.copyPages(src, [i]); doc.addPage(pg);
      results.push({ name: baseName(file.name) + '-page' + (i + 1) + '.pdf', blob: new Blob([await doc.save()], { type: 'application/pdf' }) });
    }
    return results;
  }
  function parsePageRange(str, max) {
    const pages = new Set();
    const s = String(str || '').trim();
    if (!s) { pages.add(0); return [...pages]; } // default: first page
    for (const part of s.split(',')) {
      const m = part.trim().match(/^(\d+)\s*-\s*(\d+)$/);
      if (m) { for (let i = +m[1]; i <= +m[2] && i <= max; i++) if (i >= 1) pages.add(i - 1); }
      else { const n = parseInt(part, 10); if (n >= 1 && n <= max) pages.add(n - 1); }
    }
    if (!pages.size) pages.add(0);
    return [...pages].sort((a, b) => a - b);
  }
  async function convPdfExtract(file, target, o) {
    const { PDFDocument } = await ensurePdfLib();
    const src = await PDFDocument.load(await file.arrayBuffer());
    const idx = parsePageRange(o.pages, src.getPageCount());
    const doc = await PDFDocument.create();
    const copied = await doc.copyPages(src, idx);
    copied.forEach(pg => doc.addPage(pg));
    return [out(file, '-pages.pdf', new Blob([await doc.save()], { type: 'application/pdf' }))];
  }
  async function mergePdfs(files) {
    const { PDFDocument } = await ensurePdfLib();
    const doc = await PDFDocument.create();
    for (const f of files) {
      const src = await PDFDocument.load(await f.arrayBuffer());
      const copied = await doc.copyPages(src, src.getPageIndices());
      copied.forEach(pg => doc.addPage(pg));
    }
    return [{ name: 'merged.pdf', blob: new Blob([await doc.save()], { type: 'application/pdf' }) }];
  }
  // Compress a PDF by re-rendering every page to a JPEG and rebuilding the
  // document with pdf-lib (page sizes in points are preserved, page count is
  // identical; selectable text is lost — the UI says so next to the action).
  // With o.targetKB set, walk a (scale, quality) ladder from best quality
  // down and keep the first build that fits; otherwise a single build at
  // scale 1.5 and o.quality (default 0.72). Output carries a `fit` report.
  async function convPdfCompress(file, target, o) {
    const pdf = await pdfJsDoc(file);
    const { PDFDocument } = await ensurePdfLib();
    const targetBytes = parseFloat(o.targetKB || '0') > 0 ? Math.round(parseFloat(o.targetKB) * 1024) : 0;
    const q0 = o.quality ? Math.min(0.95, Math.max(0.1, parseFloat(o.quality))) : 0.72;
    async function build(scale, q) {
      const doc = await PDFDocument.create();
      for (let p = 1; p <= pdf.numPages; p++) {
        const page = await pdf.getPage(p);
        const base = page.getViewport({ scale: 1 });
        const vp = page.getViewport({ scale });
        const cv = document.createElement('canvas'); cv.width = Math.max(1, Math.round(vp.width)); cv.height = Math.max(1, Math.round(vp.height));
        const ctx = cv.getContext('2d');
        ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, cv.width, cv.height);
        await page.render({ canvasContext: ctx, viewport: vp }).promise;
        const jpg = await canvasBlob(cv, 'image/jpeg', q);
        const img = await doc.embedJpg(new Uint8Array(await jpg.arrayBuffer()));
        const pg = doc.addPage([base.width, base.height]);
        pg.drawImage(img, { x: 0, y: 0, width: base.width, height: base.height });
      }
      return new Blob([await doc.save()], { type: 'application/pdf' });
    }
    const ladder = targetBytes
      ? [[2, 0.8], [1.75, 0.75], [1.5, 0.7], [1.3, 0.65], [1.15, 0.6], [1, 0.55], [0.85, 0.5], [0.7, 0.45], [0.6, 0.4], [0.5, 0.35]]
      : [[1.5, q0]];
    let best = null;
    for (const [s, q] of ladder) {
      const blob = await build(s, q);
      const rec = { blob, scale: s, quality: q, hit: false };
      if (!best || blob.size < best.blob.size) best = rec;
      if (targetBytes && blob.size <= targetBytes) { rec.hit = true; best = rec; break; }
      if (!targetBytes) break;
    }
    const r = out(file, '-compressed.pdf', best.blob);
    r.fit = { targetBytes: targetBytes || null, achievedBytes: best.blob.size, hit: targetBytes ? !!best.hit : null, quality: best.quality, scale: best.scale, pages: pdf.numPages, mode: 'pdf',
      legibility: (best.scale < 1.4 || best.quality < 0.5) ? 'low' : 'ok' };
    return [r];
  }

  /* ---------------- data tables ---------------- */
  const escHtml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const escXml = escHtml;
  function parseDelimited(text, delim) {
    const rows = []; let row = [], field = '', inQ = false;
    const s = String(text).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (inQ) {
        if (c === '"') { if (s[i + 1] === '"') { field += '"'; i++; } else inQ = false; }
        else field += c;
      } else if (c === '"') inQ = true;
      else if (c === delim) { row.push(field); field = ''; }
      else if (c === '\n') { row.push(field); field = ''; rows.push(row); row = []; }
      else field += c;
    }
    if (field !== '' || row.length) { row.push(field); rows.push(row); }
    return rows.filter(r => !(r.length === 1 && r[0] === ''));
  }
  function tableFrom(rowsArr) {
    if (!rowsArr.length) return { headers: [], rows: [] };
    return { headers: rowsArr[0].map(String), rows: rowsArr.slice(1).map(r => r.map(v => v == null ? '' : String(v))) };
  }
  async function readTable(file, kind) {
    const text = await file.text();
    if (kind === 'csv') return tableFrom(parseDelimited(text, ','));
    if (kind === 'tsv') return tableFrom(parseDelimited(text, '\t'));
    if (kind === 'json') {
      const data = JSON.parse(text);
      if (!Array.isArray(data)) throw new Error('JSON must be an array of objects or arrays');
      if (data.length && Array.isArray(data[0])) return tableFrom(data.map(r => r.map(v => v == null ? '' : String(v))));
      const headers = [];
      for (const o of data) for (const k of Object.keys(o)) if (!headers.includes(k)) headers.push(k);
      return { headers, rows: data.map(o => headers.map(h => o[h] == null ? '' : String(o[h]))) };
    }
    throw new Error('not a table kind: ' + kind);
  }
  function csvEscape(v) { return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; }
  function emitTable(t, target) {
    const all = [t.headers].concat(t.rows);
    if (target === 'csv') return all.map(r => r.map(csvEscape).join(',')).join('\n') + '\n';
    if (target === 'tsv') return all.map(r => r.map(v => v.replace(/[\t\n]/g, ' ')).join('\t')).join('\n') + '\n';
    if (target === 'json') return JSON.stringify(t.rows.map(r => Object.fromEntries(t.headers.map((h, i) => [h, r[i] ?? '']))), null, 2) + '\n';
    if (target === 'xml') return '<?xml version="1.0" encoding="UTF-8"?>\n<table>\n' + t.rows.map(r =>
      '  <row>' + r.map((v, i) => '<c name="' + escXml(t.headers[i] || ('col' + (i + 1))) + '">' + escXml(v) + '</c>').join('') + '</row>').join('\n') + '\n</table>\n';
    if (target === 'md') return '| ' + t.headers.map(h => h.replace(/\|/g, '\\|')).join(' | ') + ' |\n| ' + t.headers.map(() => '---').join(' | ') + ' |\n' +
      t.rows.map(r => '| ' + r.map(v => v.replace(/\|/g, '\\|')).join(' | ') + ' |').join('\n') + '\n';
    if (target === 'html') return '<!DOCTYPE html>\n<html><head><meta charset="utf-8"><title>Table</title></head><body>\n<table border="1" cellspacing="0" cellpadding="6">\n<thead><tr>' +
      t.headers.map(h => '<th>' + escHtml(h) + '</th>').join('') + '</tr></thead>\n<tbody>\n' +
      t.rows.map(r => '<tr>' + r.map(v => '<td>' + escHtml(v) + '</td>').join('') + '</tr>').join('\n') + '\n</tbody>\n</table>\n</body></html>\n';
    throw new Error('bad table target ' + target);
  }
  async function convTable(file, target, o, kind) {
    const t = await readTable(file, kind);
    const mime = { csv: 'text/csv', tsv: 'text/tab-separated-values', json: 'application/json', xml: 'application/xml', md: 'text/markdown', html: 'text/html' }[target];
    return [out(file, '.' + target, new Blob([emitTable(t, target)], { type: mime }))];
  }

  /* ---------------- text / markdown / html ---------------- */
  function mdInline(s) {
    return s
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
      .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2">$1</a>');
  }
  function mdToHtml(md) {
    const lines = String(md).replace(/\r\n/g, '\n').split('\n');
    const html = []; let inUl = false, inOl = false, inCode = false, para = [];
    const closeLists = () => { if (inUl) { html.push('</ul>'); inUl = false; } if (inOl) { html.push('</ol>'); inOl = false; } };
    const flushPara = () => { if (para.length) { html.push('<p>' + mdInline(escHtml(para.join(' '))) + '</p>'); para = []; } };
    for (const line of lines) {
      if (line.trim().startsWith('```')) {
        if (inCode) { html.push('</code></pre>'); inCode = false; } else { flushPara(); closeLists(); html.push('<pre><code>'); inCode = true; }
        continue;
      }
      if (inCode) { html.push(escHtml(line)); continue; }
      const h = line.match(/^(#{1,6})\s+(.*)$/);
      if (h) { flushPara(); closeLists(); const n = h[1].length; html.push('<h' + n + '>' + mdInline(escHtml(h[2])) + '</h' + n + '>'); continue; }
      if (/^\s*(-{3,}|\*{3,})\s*$/.test(line)) { flushPara(); closeLists(); html.push('<hr>'); continue; }
      const ul = line.match(/^\s*[-*]\s+(.*)$/);
      if (ul) { flushPara(); if (inOl) { html.push('</ol>'); inOl = false; } if (!inUl) { html.push('<ul>'); inUl = true; } html.push('<li>' + mdInline(escHtml(ul[1])) + '</li>'); continue; }
      const ol = line.match(/^\s*\d+[.)]\s+(.*)$/);
      if (ol) { flushPara(); if (inUl) { html.push('</ul>'); inUl = false; } if (!inOl) { html.push('<ol>'); inOl = true; } html.push('<li>' + mdInline(escHtml(ol[1])) + '</li>'); continue; }
      const bq = line.match(/^>\s?(.*)$/);
      if (bq) { flushPara(); closeLists(); html.push('<blockquote>' + mdInline(escHtml(bq[1])) + '</blockquote>'); continue; }
      if (!line.trim()) { flushPara(); closeLists(); continue; }
      para.push(line.trim());
    }
    flushPara(); closeLists();
    if (inCode) html.push('</code></pre>');
    return '<!DOCTYPE html>\n<html><head><meta charset="utf-8"><title>Document</title></head><body>\n' + html.join('\n') + '\n</body></html>\n';
  }
  function mdToTxt(md) {
    return String(md)
      .replace(/```[\s\S]*?```/g, m => m.replace(/```\w*\n?/g, ''))
      .replace(/^#{1,6}\s+/gm, '')
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/(\*\*|__)(.*?)\1/g, '$2')
      .replace(/(\*|_)(.*?)\1/g, '$2')
      .replace(/`([^`]+)`/g, '$1')
      .replace(/^>\s?/gm, '')
      .replace(/^\s*[-*]\s+/gm, '• ')
      .trim() + '\n';
  }
  async function textToPdfBlob(text) {
    const { PDFDocument, StandardFonts } = await ensurePdfLib();
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const size = 11, lh = 15, margin = 48, W = 595.28, H = 841.89, maxW = W - margin * 2;
    const wrapped = [];
    for (const raw of String(text).split('\n')) {
      if (!raw) { wrapped.push(''); continue; }
      let line = '';
      for (const word of raw.split(/\s+/)) {
        const t = line ? line + ' ' + word : word;
        if (font.widthOfTextAtSize(t, size) > maxW && line) { wrapped.push(line); line = word; } else line = t;
      }
      wrapped.push(line);
    }
    let page = doc.addPage([W, H]), y = H - margin;
    for (const ln of wrapped) {
      if (y < margin) { page = doc.addPage([W, H]); y = H - margin; }
      if (ln) page.drawText(ln.replace(/[^\x20-\x7E]/g, ''), { x: margin, y, size, font });
      y -= lh;
    }
    return new Blob([await doc.save()], { type: 'application/pdf' });
  }
  function htmlToTxt(htmlStr) {
    const doc = new DOMParser().parseFromString(htmlStr, 'text/html');
    const BLOCK = new Set(['P', 'DIV', 'BR', 'LI', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'TR', 'BLOCKQUOTE', 'PRE', 'SECTION', 'ARTICLE']);
    let s = '';
    (function walk(n) {
      for (const c of n.childNodes) {
        if (c.nodeType === 3) s += c.textContent;
        else if (c.nodeType === 1) { walk(c); if (BLOCK.has(c.tagName)) s += '\n'; }
      }
    })(doc.body);
    return s.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
  }
  async function convText(file, target, o, kind) {
    const text = await file.text();
    if (kind === 'txt' && target === 'html') return [out(file, '.html', new Blob(['<!DOCTYPE html>\n<html><head><meta charset="utf-8"><title>' + escHtml(baseName(file.name)) + '</title></head><body>\n' +
      text.split(/\n\s*\n/).map(p => '<p>' + escHtml(p).replace(/\n/g, '<br>') + '</p>').join('\n') + '\n</body></html>\n'], { type: 'text/html' }))];
    if (kind === 'txt' && target === 'pdf') return [out(file, '.pdf', await textToPdfBlob(text))];
    if (kind === 'md' && target === 'html') return [out(file, '.html', new Blob([mdToHtml(text)], { type: 'text/html' }))];
    if (kind === 'md' && target === 'txt') return [out(file, '.txt', new Blob([mdToTxt(text)], { type: 'text/plain' }))];
    if (kind === 'md' && target === 'pdf') return [out(file, '.pdf', await textToPdfBlob(mdToTxt(text)))];
    if (kind === 'html' && target === 'txt') return [out(file, '.txt', new Blob([htmlToTxt(text)], { type: 'text/plain' }))];
    throw new Error('unsupported text route ' + kind + '->' + target);
  }

  /* ---------------- docx ---------------- */
  function attrLocal(el, local) {
    if (!el) return '';
    for (const a of el.attributes || []) if (a.localName === local || a.name === local) return a.value;
    return '';
  }
  async function docxParagraphs(file) {
    const zip = await window.JSZip.loadAsync(await file.arrayBuffer());
    const entry = zip.file('word/document.xml');
    if (!entry) throw new Error('word/document.xml not found — not a DOCX?');
    const xml = await entry.async('string');
    const doc = new DOMParser().parseFromString(xml, 'text/xml');
    const paras = [];
    for (const p of doc.getElementsByTagNameNS('*', 'p')) {
      let text = '', html = '';
      for (const r of p.getElementsByTagNameNS('*', 'r')) {
        let rt = '';
        for (const node of r.childNodes) {
          if (node.localName === 't') rt += node.textContent;
          else if (node.localName === 'tab') rt += '\t';
          else if (node.localName === 'br') rt += '\n';
        }
        const bold = r.getElementsByTagNameNS('*', 'b').length > 0;
        text += rt;
        html += bold && rt ? '<strong>' + escHtml(rt) + '</strong>' : escHtml(rt);
      }
      let style = '';
      const pPr = p.getElementsByTagNameNS('*', 'pPr')[0];
      if (pPr) { const ps = pPr.getElementsByTagNameNS('*', 'pStyle')[0]; if (ps) style = attrLocal(ps, 'val'); }
      paras.push({ text, html, style });
    }
    return paras;
  }
  async function convDocx(file, target) {
    const paras = await docxParagraphs(file);
    if (target === 'txt') return [out(file, '.txt', new Blob([paras.map(p => p.text).join('\n') + '\n'], { type: 'text/plain' }))];
    const body = paras.map(p => {
      const m = /^Heading([1-6])$/i.exec(p.style || '');
      if (m) return '<h' + m[1] + '>' + p.html + '</h' + m[1] + '>';
      return '<p>' + (p.html || '&nbsp;') + '</p>';
    }).join('\n');
    return [out(file, '.html', new Blob(['<!DOCTYPE html>\n<html><head><meta charset="utf-8"><title>' + escHtml(baseName(file.name)) + '</title></head><body>\n' + body + '\n</body></html>\n'], { type: 'text/html' }))];
  }

  /* ---------------- subtitles ---------------- */
  function tsToSec(ts) {
    const m = String(ts).trim().replace(',', '.').match(/^(?:(\d+):)?(\d{1,2}):(\d{2})(?:\.(\d{1,3}))?$/);
    if (!m) return 0;
    return (+(m[1] || 0)) * 3600 + (+m[2]) * 60 + (+m[3]) + (+(('0.' + (m[4] || '0'))));
  }
  function secToTs(sec, comma) {
    sec = Math.max(0, sec);
    const h = Math.floor(sec / 3600), m = Math.floor(sec % 3600 / 60), s = Math.floor(sec % 60);
    const ms = Math.round((sec - Math.floor(sec)) * 1000);
    const p2 = (n) => String(n).padStart(2, '0');
    return p2(h) + ':' + p2(m) + ':' + p2(s) + (comma ? ',' : '.') + String(ms).padStart(3, '0');
  }
  function secToAss(sec) {
    const h = Math.floor(sec / 3600), m = Math.floor(sec % 3600 / 60), s = sec % 60;
    return h + ':' + String(m).padStart(2, '0') + ':' + s.toFixed(2).padStart(5, '0');
  }
  function parseCues(text, kind) {
    const cues = [];
    if (kind === 'ass') {
      let fmt = null;
      for (const line of String(text).split(/\r?\n/)) {
        if (/^Format:/i.test(line) && !fmt) fmt = line.slice(7).split(',').map(x => x.trim().toLowerCase());
        else if (/^Dialogue:/i.test(line) && fmt) {
          let rest = line.slice(9).trimStart(); const parts = [];
          for (let i = 0; i < fmt.length - 1; i++) { const idx = rest.indexOf(','); if (idx < 0) { parts.push(rest); rest = ''; } else { parts.push(rest.slice(0, idx)); rest = rest.slice(idx + 1); } }
          parts.push(rest);
          const rec = {}; fmt.forEach((f, i) => rec[f] = parts[i] || '');
          cues.push({ start: tsToSec(rec.start || '0'), end: tsToSec(rec.end || '0'), text: (rec.text || '').replace(/\{[^}]*\}/g, '').replace(/\\N/gi, '\n') });
        }
      }
      return cues;
    }
    const blocks = String(text).replace(/^WEBVTT[^\n]*\n/, '').split(/\n\s*\n/);
    for (const b of blocks) {
      const lines = b.split(/\r?\n/).filter(l => l.trim() !== '');
      const ti = lines.findIndex(l => l.includes('-->'));
      if (ti < 0) continue;
      const [a, bb] = lines[ti].split('-->').map(x => x.trim().split(/\s+/)[0]);
      cues.push({ start: tsToSec(a), end: tsToSec(bb), text: lines.slice(ti + 1).join('\n') });
    }
    return cues;
  }
  function emitCues(cues, target) {
    if (target === 'srt') return cues.map((c, i) => (i + 1) + '\n' + secToTs(c.start, true) + ' --> ' + secToTs(c.end, true) + '\n' + c.text).join('\n\n') + '\n';
    if (target === 'vtt') return 'WEBVTT\n\n' + cues.map(c => secToTs(c.start) + ' --> ' + secToTs(c.end) + '\n' + c.text).join('\n\n') + '\n';
    if (target === 'ass') return '[Script Info]\nTitle: SabConvert\nScriptType: v4.00+\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n' +
      cues.map(c => 'Dialogue: 0,' + secToAss(c.start) + ',' + secToAss(c.end) + ',Default,,0,0,0,,' + c.text.replace(/\n/g, '\\N')).join('\n') + '\n';
    throw new Error('bad subtitle target ' + target);
  }
  async function convSubtitle(file, target, o, kind) {
    const cues = parseCues(await file.text(), kind);
    if (!cues.length) throw new Error('no cues parsed');
    return [out(file, '.' + target, new Blob([emitCues(cues, target)], { type: 'text/plain' }))];
  }

  /* ---------------- archives & base64 ---------------- */
  async function convZipPack(file) {
    const zip = new window.JSZip();
    zip.file(file.name, file);
    return [out(file, '.zip', await zip.generateAsync({ type: 'blob' }))];
  }
  async function convZipExtract(file) {
    const zip = await window.JSZip.loadAsync(await file.arrayBuffer());
    const results = [];
    const entries = Object.values(zip.files).filter(e => !e.dir);
    if (!entries.length) throw new Error('zip is empty');
    for (const e of entries) {
      const safe = e.name.split('/').filter(p => p && p !== '..').join('/');
      if (!safe) continue;
      results.push({ name: safe, blob: await e.async('blob') });
    }
    return results;
  }
  async function convB64Encode(file) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    const b64 = btoa(bin).replace(/(.{76})/g, '$1\n');
    const text = '# sabconvert-b64 name=' + encodeURIComponent(file.name) + '\n' + b64 + '\n';
    return [out(file, '.b64', new Blob([text], { type: 'text/plain' }))];
  }
  async function convB64Decode(file) {
    const text = await file.text();
    const m = text.match(/^#\s*sabconvert-b64\s+name=(\S+)/m);
    const name = m ? decodeURIComponent(m[1]) : 'decoded.bin';
    const clean = text.replace(/^#.*$/gm, '').replace(/\s+/g, '');
    const bin = atob(clean);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return [{ name, blob: new Blob([bytes]) }];
  }

  /* ---------------- video ---------------- */
  function loadVideo(file) {
    return new Promise((res, rej) => {
      const v = document.createElement('video');
      v.muted = true; v.playsInline = true; v.preload = 'auto';
      v.onerror = () => rej(new Error('video cannot be decoded by this browser'));
      v.onloadedmetadata = () => res(v);
      v.src = URL.createObjectURL(file);
    });
  }
  function seek(v, t) {
    return new Promise((res) => { const h = () => { v.removeEventListener('seeked', h); res(); }; v.addEventListener('seeked', h); v.currentTime = t; });
  }
  async function videoFrameBlob(file) {
    const v = await loadVideo(file);
    try {
      await seek(v, Math.min(1, (v.duration || 2) / 2));
      const cv = document.createElement('canvas'); cv.width = v.videoWidth; cv.height = v.videoHeight;
      cv.getContext('2d').drawImage(v, 0, 0);
      return await canvasBlob(cv, 'image/jpeg', 0.9);
    } finally { URL.revokeObjectURL(v.src); }
  }
  async function convVideoFrame(file) {
    return [out(file, '-frame.jpg', await videoFrameBlob(file))];
  }
  async function renderVideoGif(v, GIF, width, fps) {
    const dur = Math.min(v.duration || 1, 3), n = Math.max(2, Math.round(dur * fps));
    const scale = width / (v.videoWidth || width);
    const cv = document.createElement('canvas');
    cv.width = width; cv.height = Math.max(2, Math.round((v.videoHeight || 240) * Math.min(1, scale)));
    const ctx = cv.getContext('2d');
    const gif = new GIF({ workers: 2, quality: 12, width: cv.width, height: cv.height, workerScript: 'gif.worker.js' });
    for (let i = 0; i < n; i++) { await seek(v, (i / fps) + 0.01); ctx.drawImage(v, 0, 0, cv.width, cv.height); gif.addFrame(cv, { copy: true, delay: Math.round(1000 / fps) }); }
    return new Promise((res, rej) => { gif.on('finished', res); gif.on('abort', () => rej(new Error('gif aborted'))); gif.render(); });
  }
  async function convVideoToGif(file, target, o) {
    const GIF = await ensureGif();
    const v = await loadVideo(file);
    try {
      const targetKB = parseFloat((o && o.targetKB) || '0');
      if (!(targetKB > 0)) return [out(file, '.gif', await renderVideoGif(v, GIF, 320, 8))];
      // Fit under the target by shrinking width, then frame rate.
      const targetBytes = Math.round(targetKB * 1024);
      const ladder = [[320, 8], [256, 8], [224, 7], [192, 7], [160, 6], [128, 5], [96, 5]];
      let best = null;
      for (const [w, fps] of ladder) {
        const blob = await renderVideoGif(v, GIF, w, fps);
        if (!best || blob.size < best.blob.size) best = { blob, width: w, hit: false };
        if (blob.size <= targetBytes) { best = { blob, width: w, hit: true }; break; }
      }
      const r = out(file, '.gif', best.blob);
      r.fit = { targetBytes, achievedBytes: best.blob.size, hit: best.hit, quality: null, scale: best.width / 320, mode: 'gif', legibility: 'ok' };
      return [r];
    } finally { URL.revokeObjectURL(v.src); }
  }

  /* ---------------- dispatcher ---------------- */
  const SC_CONVERTERS = {
    image: convImage, imageToPdf: convImageToPdf,
    pdfToImages: convPdfToImages, pdfToText: convPdfToText, pdfSplit: convPdfSplit, pdfExtract: convPdfExtract,
    pdfCompress: convPdfCompress,
    table: convTable, subtitle: convSubtitle,
    zipPack: convZipPack, zipExtract: convZipExtract, b64Encode: convB64Encode, b64Decode: convB64Decode,
    videoFrame: convVideoFrame, videoToGif: convVideoToGif,
  };
  // Turn engine failures into plain-words reasons a person can act on.
  // PDF failures are probed with pdf.js: a PasswordException means the
  // file is locked (the single most confusing converter failure there is),
  // an InvalidPDFException means it is corrupt or not really a PDF.
  const PASSWORD_MSG = 'This PDF is password-protected. Remove the password first, then try again.';
  const CORRUPT_PDF_MSG = 'This file looks corrupt, or isn’t really a PDF — the converter couldn’t read it.';
  async function friendlyError(file, e) {
    const kind = R.classify(file);
    const msg = (e && e.message) || String(e);
    if (kind === 'pdf') {
      if ((e && e.name === 'PasswordException') || /password/i.test(msg)) return new Error(PASSWORD_MSG);
      if ((e && e.name === 'InvalidPDFException') || /invalid pdf/i.test(msg)) return new Error(CORRUPT_PDF_MSG);
      try { await pdfJsDoc(file); } catch (probe) {
        if (probe && probe.name === 'PasswordException') return new Error(PASSWORD_MSG);
        if (probe && (probe.name === 'InvalidPDFException' || /invalid pdf/i.test(probe.message || ''))) return new Error(CORRUPT_PDF_MSG);
      }
      return e;
    }
    if ((kind === 'image' || kind === 'heic') && /could not be decoded|decod|bitmap/i.test(msg)) {
      return new Error('This image couldn’t be read — the file may be corrupt, or not really a ' + (R.extOf(file.name) || 'image').toUpperCase() + '.');
    }
    return e;
  }
  async function convert(file, target, options) {
    try { return await convertInner(file, target, options); }
    catch (e) { throw await friendlyError(file, e); }
  }
  async function convertInner(file, target, options) {
    const o = options || {};
    const kind = R.classify(file);
    const outs = R.outputsFor(kind);
    const route = outs.find(r => r.to === target);
    if (!route) throw new Error('route not offered: ' + (kind || 'unknown') + ' -> ' + target);
    switch (route.conv) {
      case 'table': return convTable(file, target, o, kind);
      case 'subtitle': return convSubtitle(file, target, o, kind);
      case 'docxToTxt': case 'docxToHtml': return convDocx(file, target);
      case 'txtToHtml': case 'txtToPdf': case 'mdToHtml': case 'mdToTxt': case 'mdToPdf': case 'htmlToTxt':
        return convText(file, target, o, kind);
      default: {
        const fn = SC_CONVERTERS[route.conv];
        if (!fn) throw new Error('no converter for ' + route.conv);
        return fn(file, target, o);
      }
    }
  }

  window.SabConvert = { convert, mergePdfs, compressPdf: convPdfCompress, formFit, imageInfo, pdfThumb, videoThumb: videoFrameBlob, previewSource, registry: R, converters: SC_CONVERTERS,
    _test: { parseDelimited, emitTable, mdToHtml, mdToTxt, htmlToTxt, parseCues, emitCues, parsePageRange, encodeBMP, parseExifOrientation, parseHeifIrot, padJpegBlob } };
})();
