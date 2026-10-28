'use strict';
/* SabConvert — UI. Uses window.SabConvert.convert (same engine the harness tests). */
(function () {
  const R = window.SC_REGISTRY;
  const dz = document.getElementById('dropzone');
  const input = document.getElementById('fileInput');
  const cardsEl = document.getElementById('cards');
  const toolbar = document.getElementById('toolbar');
  const summary = document.getElementById('summary');
  const mergeBtn = document.getElementById('mergePdfs');
  const dlAllBtn = document.getElementById('downloadAll');
  const mergeResultEl = document.getElementById('mergeResult');
  let items = [], seq = 0;

  const fmtSize = (n) => n < 1024 ? n + ' B' : n < 1048576 ? (n / 1024).toFixed(1) + ' KB' : (n / 1048576).toFixed(2) + ' MB';
  document.getElementById('routeStats').textContent =
    R.routeCount() + ' format routes + per-file Base64 & ZIP — images, PDF, tables, documents, subtitles, archives, video.';
  document.getElementById('footRoutes').textContent = 'Routes are verified by an automated in-browser test harness; only routes that pass are listed.';

  /* ---------- lightbox (one overlay for all previews) ---------- */
  const lightbox = document.createElement('div');
  lightbox.id = 'lightbox'; lightbox.hidden = true;
  lightbox.innerHTML = '<figure><img alt="Large preview"><figcaption></figcaption></figure><button class="lb-close" type="button" title="Close (Esc)">✕</button>';
  document.body.appendChild(lightbox);
  const lbImg = lightbox.querySelector('img'), lbCap = lightbox.querySelector('figcaption');
  function openLightbox(url, caption) { lbImg.src = url; lbCap.textContent = caption || ''; lightbox.hidden = false; }
  function closeLightbox() { lightbox.hidden = true; lbImg.removeAttribute('src'); }
  lightbox.addEventListener('click', e => { if (e.target !== lbImg) closeLightbox(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && !lightbox.hidden) closeLightbox(); });

  dz.addEventListener('click', () => input.click());
  dz.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); } });
  input.addEventListener('change', () => { addFiles([...input.files]); input.value = ''; });
  ['dragenter', 'dragover'].forEach(ev => dz.addEventListener(ev, e => { e.preventDefault(); dz.classList.add('over'); }));
  ['dragleave', 'drop'].forEach(ev => dz.addEventListener(ev, e => { e.preventDefault(); dz.classList.remove('over'); }));
  dz.addEventListener('drop', e => addFiles([...e.dataTransfer.files]));
  document.addEventListener('dragover', e => e.preventDefault());
  document.addEventListener('drop', e => e.preventDefault());

  function addFiles(files) {
    for (const f of files) {
      const kind = R.classify(f);
      items.push({ id: ++seq, file: f, kind, target: null, status: 'ready', results: [], error: '', options: {} });
    }
    render();
  }

  function metaText(it) {
    const kindLabel = it.kind ? R.KINDS[it.kind].label : 'Unknown type';
    let s = kindLabel + ' · ' + fmtSize(it.file.size);
    if (it.natural) s += ' · ' + it.natural.width + ' × ' + it.natural.height + ' px';
    if (it.pages) s += ' · ' + it.pages + (it.pages === 1 ? ' page' : ' pages');
    return s;
  }

  function optionControls(it) {
    if (it.kind === 'image') return '<div class="opts">' +
      '<label class="ctl-q">Quality <input type="range" min="0.3" max="1" step="0.02" value="0.92" data-opt="quality"><span class="qv">0.92</span></label>' +
      '<label>Max size <select data-opt="maxDim"><option value="0">Original</option><option value="2048">2048px</option><option value="1024">1024px</option><option value="800">800px</option></select></label>' +
      '<label>Rotate <select data-opt="rotate"><option value="0">0°</option><option value="90">90°</option><option value="180">180°</option><option value="270">270°</option></select></label>' +
      '<label><input type="checkbox" data-opt="grayscale"> Grayscale</label></div>' +
      '<div class="opts img-extra">' +
      '<span class="rsz">Resize <input type="number" data-opt="width" min="1" placeholder="width"> × <input type="number" data-opt="height" min="1" placeholder="height"> px</span>' +
      '<label><input type="checkbox" class="aspectLock" checked> Lock aspect</label>' +
      '<label>Preset <select class="szPreset"><option value="">—</option><option value="100">100%</option><option value="75">75%</option><option value="50">50%</option><option value="25">25%</option></select></label>' +
      '<span class="dims"></span></div>' +
      '<div class="opts img-kb">' +
      '<label>Max size <input type="number" data-opt="targetKB" min="1" placeholder="e.g. 200"> KB</label>' +
      '<span class="kb-note"></span></div>';
    if (it.kind === 'pdf') return '<div class="opts pdf-pages"><label>Pages for “Extract” <input type="text" data-opt="pages" placeholder="e.g. 1-2,4 (blank = page 1)" size="24"></label></div>' +
      '<div class="opts pdf-comp" hidden>' +
      '<label>Quality <input type="range" min="0.35" max="0.9" step="0.01" value="0.72" data-opt="quality"><span class="qv">0.72</span></label>' +
      '<label>Target size <input type="number" data-opt="targetKB" min="1" placeholder="KB"> KB <span class="kb-hint">(optional — blank = just compress)</span></label></div>' +
      '<p class="honest pdf-comp-note" hidden>Compress re-renders every page as an image — the PDF gets smaller, but its text will no longer be selectable or searchable.</p>';
    return '';
  }

  function previewHtml(it) {
    if (it.kind === 'image') return '<button class="preview" type="button" title="Click for a large view"><img class="thumb" alt="Preview of the image"></button>';
    if (it.kind === 'pdf') return '<button class="preview" type="button" title="First page — click for a large view"><span class="thumb-tile">PDF · rendering page 1…</span><img class="thumb" alt="First page preview" hidden></button>';
    if (it.kind === 'video') return '<button class="preview" type="button" title="Video frame — click for a large view"><span class="thumb-tile">▶ Video · capturing a frame…</span><img class="thumb" alt="Video frame preview" hidden></button>';
    return '';
  }

  // Show/hide the option blocks that only apply to the chosen target.
  function refreshOptVisibility(card, it) {
    const t = it.target;
    if (it.kind === 'image') {
      const imgOut = ['jpg', 'png', 'webp', 'bmp', 'gif'].includes(t);
      const q = card.querySelector('.ctl-q'); if (q) q.style.display = (t === 'jpg' || t === 'webp') ? '' : 'none';
      const extra = card.querySelector('.img-extra'); if (extra) extra.style.display = (imgOut || t === 'pdf') ? '' : 'none';
      const kb = card.querySelector('.img-kb'); if (kb) kb.style.display = (t === 'jpg' || t === 'webp' || t === 'png') ? '' : 'none';
      const note = card.querySelector('.kb-note');
      if (note) note.textContent = t === 'png' ? 'PNG is lossless — the size is cut by resizing only.'
        : (t === 'jpg' || t === 'webp') ? 'The converter searches quality first, then size, to fit under it.' : '';
    }
    if (it.kind === 'pdf') {
      const pages = card.querySelector('.pdf-pages'); if (pages) pages.style.display = t === 'extract' ? '' : 'none';
      const comp = card.querySelector('.pdf-comp'); if (comp) comp.hidden = t !== 'compress';
      const note = card.querySelector('.pdf-comp-note'); if (note) note.hidden = t !== 'compress';
    }
  }

  function render() {
    toolbar.hidden = items.length === 0;
    const pdfCount = items.filter(i => i.kind === 'pdf').length;
    mergeBtn.hidden = pdfCount < 2;
    const done = items.filter(i => i.status === 'done').length;
    dlAllBtn.hidden = !items.some(i => i.results.length) && !mergeResultEl.children.length;
    summary.textContent = items.length ? items.length + ' file(s)' + (done ? ' · ' + done + ' converted' : '') : '';
    cardsEl.innerHTML = '';
    for (const it of items) {
      const outs = R.outputsFor(it.kind);
      if (!it.target || !outs.some(o => o.to === it.target)) it.target = outs[0] && outs[0].to;
      const card = document.createElement('article');
      card.className = 'card';
      card.dataset.id = it.id;
      const extTag = (R.extOf(it.file.name) || 'file').toUpperCase();
      card.innerHTML =
        '<div class="card-head"><span class="icon-tile kind-' + (it.kind || 'unknown') + '" aria-hidden="true">' + extTag + '</span>' +
        '<span class="fname-wrap"><strong class="fname"></strong><span class="meta"></span></span>' +
        '<button class="x" title="Remove">✕</button></div>' +
        (it.kind ? '' : '<p class="warn">Format not in the converter list — you can still Base64-encode or ZIP it.</p>') +
        previewHtml(it) +
        '<div class="row"><label class="to-label">To: <select class="target">' +
        outs.map(o => '<option value="' + o.to + '"' + (o.to === it.target ? ' selected' : '') + '>' + o.label + '</option>').join('') +
        '</select></label>' +
        '<button class="primary convert">Convert</button>' +
        '<span class="status"></span></div>' +
        optionControls(it) +
        '<div class="progress" hidden><div class="bar"></div></div>' +
        '<div class="results"></div>';
      card.querySelector('.fname').textContent = it.file.name;
      card.querySelector('.meta').textContent = metaText(it);
      const sel = card.querySelector('.target');
      const statusEl = card.querySelector('.status');
      const resultsEl = card.querySelector('.results');
      sel.addEventListener('change', () => { it.target = sel.value; refreshOptVisibility(card, it); });
      card.querySelectorAll('[data-opt]').forEach(el => {
        const k = el.dataset.opt;
        if (it.options[k] !== undefined) { // keep chosen options across re-renders
          if (el.type === 'checkbox') el.checked = !!it.options[k]; else el.value = it.options[k];
          const qv0 = card.querySelector('.qv'); if (qv0 && k === 'quality') qv0.textContent = el.value;
        }
        el.addEventListener('change', () => {
          it.options[k] = el.type === 'checkbox' ? el.checked : el.value;
          const qv = card.querySelector('.qv'); if (qv && k === 'quality') qv.textContent = el.value;
        });
        if (el.type === 'checkbox') it.options[el.dataset.opt] = el.checked;
        else it.options[el.dataset.opt] = el.value;
      });
      // Resize helpers: aspect lock + % presets (need the natural size).
      const wIn = card.querySelector('[data-opt="width"]'), hIn = card.querySelector('[data-opt="height"]');
      if (wIn && hIn) {
        const lock = card.querySelector('.aspectLock');
        const syncPair = (changed) => {
          if (!lock || !lock.checked || !it.natural) return;
          if (changed === 'w') { const w = parseInt(wIn.value, 10); if (w > 0) { const h = Math.max(1, Math.round(w * it.natural.height / it.natural.width)); hIn.value = h; it.options.height = String(h); } }
          else { const h = parseInt(hIn.value, 10); if (h > 0) { const w = Math.max(1, Math.round(h * it.natural.width / it.natural.height)); wIn.value = w; it.options.width = String(w); } }
        };
        wIn.addEventListener('change', () => syncPair('w'));
        hIn.addEventListener('change', () => syncPair('h'));
        const preset = card.querySelector('.szPreset');
        if (preset) preset.addEventListener('change', () => {
          const p = parseInt(preset.value, 10); if (!p || !it.natural) return;
          const w = Math.max(1, Math.round(it.natural.width * p / 100)), h = Math.max(1, Math.round(it.natural.height * p / 100));
          wIn.value = w; hIn.value = h; it.options.width = String(w); it.options.height = String(h);
        });
      }
      card.querySelector('.x').addEventListener('click', () => {
        if (it.previewUrl) URL.revokeObjectURL(it.previewUrl);
        if (it.thumbUrl) URL.revokeObjectURL(it.thumbUrl);
        items = items.filter(x => x !== it); render();
      });
      card.querySelector('.convert').addEventListener('click', () => convertItem(it, statusEl, resultsEl));
      refreshOptVisibility(card, it);
      wirePreview(card, it);
      if (it.status === 'error') { statusEl.textContent = '✗ ' + it.error; statusEl.className = 'status err'; }
      if (it.status === 'done') paintResults(it, resultsEl, statusEl);
      cardsEl.appendChild(card);
    }
  }

  // Thumbnail previews: images use an object URL directly; PDFs render page 1
  // via pdf.js; videos capture one frame. Generated once per item and cached.
  function wirePreview(card, it) {
    const btn = card.querySelector('.preview');
    if (!btn) return;
    const img = btn.querySelector('.thumb');
    const tile = btn.querySelector('.thumb-tile');
    const show = (url) => { img.src = url; img.hidden = false; if (tile) tile.hidden = true; };
    if (it.kind === 'image') {
      if (!it.previewUrl) it.previewUrl = URL.createObjectURL(it.file);
      show(it.previewUrl);
      const fillDims = () => {
        card.querySelector('.meta').textContent = metaText(it);
        const wIn = card.querySelector('[data-opt="width"]'), hIn = card.querySelector('[data-opt="height"]');
        if (wIn) wIn.placeholder = String(it.natural.width);
        if (hIn) hIn.placeholder = String(it.natural.height);
        const dims = card.querySelector('.dims'); if (dims) dims.textContent = 'original ' + it.natural.width + ' × ' + it.natural.height + ' px';
      };
      if (it.natural) fillDims();
      else if (!it.infoBusy) {
        it.infoBusy = true;
        window.SabConvert.imageInfo(it.file).then(d => {
          it.natural = d; it.infoBusy = false;
          if (card.isConnected) fillDims();
        }).catch(() => { it.infoBusy = false; });
      }
    } else if (it.thumbUrl) {
      show(it.thumbUrl);
    } else if (!it.thumbBusy && (it.kind === 'pdf' || it.kind === 'video')) {
      it.thumbBusy = true;
      const job = it.kind === 'pdf' ? window.SabConvert.pdfThumb(it.file, 360) : window.SabConvert.videoThumb(it.file);
      Promise.resolve(job).then(r => {
        it.thumbBusy = false;
        if (it.kind === 'pdf') { it.pages = r.pages; it.thumbUrl = URL.createObjectURL(r.blob); }
        else it.thumbUrl = URL.createObjectURL(r);
        if (card.isConnected) { show(it.thumbUrl); card.querySelector('.meta').textContent = metaText(it); }
      }).catch(() => {
        it.thumbBusy = false;
        if (tile && card.isConnected) tile.textContent = it.kind === 'pdf' ? 'PDF · preview unavailable' : '▶ Video · preview unavailable in this browser';
      });
    }
    btn.addEventListener('click', () => {
      const url = it.kind === 'image' ? it.previewUrl : it.thumbUrl;
      if (url) openLightbox(url, it.file.name);
    });
  }

  function sizeDelta(it, outSize) {
    const inn = it.file.size;
    if (!inn) return fmtSize(outSize);
    const pct = Math.round((outSize - inn) / inn * 100);
    const sign = pct > 0 ? '+' + pct + '%' : pct < 0 ? '−' + Math.abs(pct) + '%' : '±0%';
    return fmtSize(inn) + ' → ' + fmtSize(outSize) + ' (' + sign + ')';
  }
  function fitText(r) {
    const f = r.fit;
    if (f.mode === 'pdf') {
      const pages = f.pages + (f.pages === 1 ? ' page' : ' pages') + ' kept';
      if (!f.targetBytes) return 'Compressed · ' + pages + ' · pages re-rendered as images at ' + Math.round(f.scale * 100) + '% scale, quality ' + f.quality + ' — text no longer selectable.';
      return f.hit
        ? 'Target met: ' + fmtSize(f.achievedBytes) + ' ≤ ' + fmtSize(f.targetBytes) + ' · ' + pages + '.'
        : 'Couldn’t reach ' + fmtSize(f.targetBytes) + ' — the smallest we got was ' + fmtSize(f.achievedBytes) + ' · ' + pages + '.';
    }
    if (f.mode === 'scale') return f.hit
      ? 'Target met by resizing only (PNG is lossless): ' + fmtSize(f.achievedBytes) + ' at ' + Math.round(f.scale * 100) + '% size.'
      : 'Couldn’t reach ' + fmtSize(f.targetBytes) + ' by resizing alone (PNG is lossless) — smallest was ' + fmtSize(f.achievedBytes) + '.';
    return f.hit
      ? 'Target met: ' + fmtSize(f.achievedBytes) + ' (quality ' + (f.quality != null ? f.quality.toFixed(2) : '—') + (f.scale < 1 ? ', resized to ' + Math.round(f.scale * 100) + '%' : '') + ').'
      : 'Couldn’t go below ' + fmtSize(f.achievedBytes) + ' at readable quality (target was ' + fmtSize(f.targetBytes) + ').';
  }

  function paintResults(it, resultsEl, statusEl) {
    resultsEl.innerHTML = '';
    for (const r of it.results) {
      const row = document.createElement('div'); row.className = 'dl-row';
      const a = document.createElement('a');
      a.href = URL.createObjectURL(r.blob); a.download = r.name; a.className = 'dl';
      a.textContent = '⬇ ' + r.name;
      const sz = document.createElement('span');
      sz.className = 'sz'; sz.textContent = sizeDelta(it, r.blob.size);
      row.appendChild(a); row.appendChild(sz);
      resultsEl.appendChild(row);
      if (r.fit) {
        const note = document.createElement('p');
        note.className = 'fitnote' + (r.fit.hit === false ? ' miss' : '');
        note.textContent = fitText(r);
        resultsEl.appendChild(note);
      }
    }
    statusEl.textContent = '✓ done'; statusEl.className = 'status ok';
  }

  async function convertItem(it, statusEl, resultsEl) {
    statusEl.textContent = 'converting…'; statusEl.className = 'status';
    const card = statusEl.closest('.card');
    const prog = card && card.querySelector('.progress');
    const bar = prog && prog.querySelector('.bar');
    if (prog && bar) { prog.hidden = false; bar.className = 'bar run'; }
    try {
      it.results = await window.SabConvert.convert(it.file, it.target, it.options);
      it.status = 'done'; it.error = '';
      if (bar) bar.className = 'bar full';
      paintResults(it, resultsEl, statusEl);
    } catch (e) {
      it.status = 'error'; it.error = e.message || String(e); it.results = [];
      if (prog) prog.hidden = true;
      statusEl.textContent = '✗ ' + it.error; statusEl.className = 'status err';
    }
    renderSummaryOnly();
  }
  function renderSummaryOnly() {
    const done = items.filter(i => i.status === 'done').length;
    summary.textContent = items.length + ' file(s)' + (done ? ' · ' + done + ' converted' : '');
    dlAllBtn.hidden = !items.some(i => i.results.length) && !mergeResultEl.children.length;
  }

  document.getElementById('convertAll').addEventListener('click', async () => {
    const cards = [...cardsEl.children];
    for (let i = 0; i < items.length; i++) {
      const c = cards[i]; if (!c) continue;
      await convertItem(items[i], c.querySelector('.status'), c.querySelector('.results'));
    }
  });
  mergeBtn.addEventListener('click', async () => {
    mergeBtn.disabled = true; mergeBtn.textContent = 'Merging…';
    try {
      const pdfItems = items.filter(i => i.kind === 'pdf');
      const res = await window.SabConvert.mergePdfs(pdfItems.map(i => i.file));
      const totalIn = pdfItems.reduce((s, i) => s + i.file.size, 0);
      mergeResultEl.innerHTML = '';
      for (const r of res) {
        const row = document.createElement('div'); row.className = 'dl-row';
        const a = document.createElement('a');
        a.href = URL.createObjectURL(r.blob); a.download = r.name; a.className = 'dl';
        a.textContent = '⬇ ' + r.name + ' (' + fmtSize(r.blob.size) + ')';
        const sz = document.createElement('span');
        sz.className = 'sz'; sz.textContent = fmtSize(totalIn) + ' → ' + fmtSize(r.blob.size);
        row.appendChild(a); row.appendChild(sz);
        mergeResultEl.appendChild(row);
      }
    } catch (e) { mergeResultEl.textContent = 'Merge failed: ' + e.message; }
    mergeBtn.disabled = false; mergeBtn.textContent = 'Merge all PDFs into one';
    renderSummaryOnly();
  });
  dlAllBtn.addEventListener('click', async () => {
    const zip = new window.JSZip();
    let n = 0;
    for (const it of items) for (const r of it.results) zip.file(r.name, r.blob), n++;
    for (const a of mergeResultEl.querySelectorAll('a.dl')) { /* merged result already zippable via its own link */ }
    if (!n) return;
    const blob = await zip.generateAsync({ type: 'blob' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = 'sabconvert-results.zip'; a.click();
  });
  document.getElementById('clearAll').addEventListener('click', () => {
    for (const it of items) {
      if (it.previewUrl) URL.revokeObjectURL(it.previewUrl);
      if (it.thumbUrl) URL.revokeObjectURL(it.thumbUrl);
    }
    items = []; mergeResultEl.innerHTML = ''; render();
  });

  render();
})();
