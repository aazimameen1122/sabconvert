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

  const isImg = (k) => k === 'image' || k === 'heic';
  const DEST_CHIPS = '<span class="dest-chips">Quick sizes:' +
    '<button type="button" class="dchip" data-kb="200">Portal 200 KB</button>' +
    '<button type="button" class="dchip" data-kb="100">Portal 100 KB</button>' +
    '<button type="button" class="dchip" data-kb="256">Discord emoji GIF 256 KB</button>' +
    '<button type="button" class="dchip" data-kb="18432">Gmail-safe ≈18 MB</button></span>';

  function optionControls(it) {
    if (isImg(it.kind)) return '<div class="opts">' +
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
      '<span class="kb-note"></span>' + DEST_CHIPS + '</div>';
    if (it.kind === 'pdf') return '<div class="opts pdf-pages"><label>Pages for “Extract” <input type="text" data-opt="pages" placeholder="e.g. 1-2,4 (blank = page 1)" size="24"></label></div>' +
      '<div class="opts pdf-comp" hidden>' +
      '<label>Quality <input type="range" min="0.35" max="0.9" step="0.01" value="0.72" data-opt="quality"><span class="qv">0.72</span></label>' +
      '<label>Target size <input type="number" data-opt="targetKB" min="1" placeholder="KB"> KB <span class="kb-hint">(optional — blank = just compress)</span></label>' + DEST_CHIPS + '</div>' +
      '<p class="honest pdf-comp-note" hidden>Compress re-renders every page as an image — the PDF gets smaller, but its text will no longer be selectable or searchable.</p>';
    return '';
  }

  function previewHtml(it) {
    if (it.kind === 'heic') return '<button class="preview" type="button" title="Click for a large view"><span class="thumb-tile">HEIC · decoding…</span><img class="thumb" alt="Preview of the HEIC photo" hidden></button>';
    if (it.kind === 'image') return '<button class="preview" type="button" title="Click for a large view"><img class="thumb" alt="Preview of the image"></button>';
    if (it.kind === 'pdf') return '<button class="preview" type="button" title="First page — click for a large view"><span class="thumb-tile">PDF · rendering page 1…</span><img class="thumb" alt="First page preview" hidden></button>';
    if (it.kind === 'video') return '<button class="preview" type="button" title="Video frame — click for a large view"><span class="thumb-tile">▶ Video · capturing a frame…</span><img class="thumb" alt="Video frame preview" hidden></button>';
    return '';
  }

  // Show/hide the option blocks that only apply to the chosen target.
  function refreshOptVisibility(card, it) {
    const t = it.target;
    if (isImg(it.kind)) {
      const imgOut = ['jpg', 'png', 'webp', 'bmp', 'gif'].includes(t);
      const q = card.querySelector('.ctl-q'); if (q) q.style.display = (t === 'jpg' || t === 'webp') ? '' : 'none';
      const extra = card.querySelector('.img-extra'); if (extra) extra.style.display = (imgOut || t === 'pdf') ? '' : 'none';
      const kb = card.querySelector('.img-kb'); if (kb) kb.style.display = (t === 'jpg' || t === 'webp' || t === 'png' || t === 'gif') ? '' : 'none';
      const note = card.querySelector('.kb-note');
      if (note) note.textContent = t === 'png' ? 'PNG is lossless — the size is cut by resizing only.'
        : t === 'gif' ? 'GIF has no quality knob — dimensions (and frames, for video) shrink to fit under it.'
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
    const pdfTotal = items.filter(i => i.kind === 'pdf').length;
    let pdfSeen = 0;
    for (const it of items) {
      if (it.kind === 'pdf') it.pdfNo = ++pdfSeen; else it.pdfNo = 0;
      const outs = R.outputsFor(it.kind);
      if (!it.target || !outs.some(o => o.to === it.target)) it.target = outs[0] && outs[0].to;
      const card = document.createElement('article');
      card.className = 'card';
      card.dataset.id = it.id;
      const extTag = (R.extOf(it.file.name) || 'file').toUpperCase();
      card.innerHTML =
        '<div class="card-head"><span class="icon-tile kind-' + (it.kind || 'unknown') + '" aria-hidden="true">' + extTag + '</span>' +
        '<span class="fname-wrap"><strong class="fname"></strong><span class="meta"></span></span>' +
        (it.pdfNo && pdfTotal > 1 ? '<span class="ord" title="Files merge in the order they were added">PDF ' + it.pdfNo + ' of ' + pdfTotal + ' · merge order</span>' : '') +
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
      card.querySelectorAll('.dchip').forEach(ch => ch.addEventListener('click', () => {
        const inp = card.querySelector('[data-opt="targetKB"]');
        if (inp) { inp.value = ch.dataset.kb; inp.dispatchEvent(new Event('change')); }
      }));
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

  function fillImageDims(card, it) {
    if (!it.natural) return;
    card.querySelector('.meta').textContent = metaText(it);
    const wIn = card.querySelector('[data-opt="width"]'), hIn = card.querySelector('[data-opt="height"]');
    if (wIn) wIn.placeholder = String(it.natural.width);
    if (hIn) hIn.placeholder = String(it.natural.height);
    const dims = card.querySelector('.dims'); if (dims) dims.textContent = 'original ' + it.natural.width + ' × ' + it.natural.height + ' px';
  }
  function loadNatural(card, it) {
    if (it.natural) { fillImageDims(card, it); return; }
    if (it.infoBusy) return;
    it.infoBusy = true;
    window.SabConvert.imageInfo(it.file).then(d => {
      it.natural = d; it.infoBusy = false;
      if (card.isConnected) fillImageDims(card, it);
    }).catch(() => { it.infoBusy = false; });
  }

  // Thumbnail previews: images use an object URL directly; PDFs render page 1
  // via pdf.js; videos capture one frame; HEIC shows its decoded PNG (the
  // only form a browser <img> can display). Generated once per item, cached.
  function wirePreview(card, it) {
    const btn = card.querySelector('.preview');
    if (!btn) return;
    const img = btn.querySelector('.thumb');
    const tile = btn.querySelector('.thumb-tile');
    const show = (url) => { img.src = url; img.hidden = false; if (tile) tile.hidden = true; };
    if (it.kind === 'image') {
      if (!it.previewUrl) it.previewUrl = URL.createObjectURL(it.file);
      show(it.previewUrl);
      loadNatural(card, it);
    } else if (it.thumbUrl) {
      show(it.thumbUrl);
      if (it.kind === 'heic') loadNatural(card, it);
    } else if (!it.thumbBusy && (it.kind === 'pdf' || it.kind === 'video' || it.kind === 'heic')) {
      it.thumbBusy = true;
      const job = it.kind === 'pdf' ? window.SabConvert.pdfThumb(it.file, 360)
        : it.kind === 'heic' ? window.SabConvert.previewSource(it.file)
        : window.SabConvert.videoThumb(it.file);
      Promise.resolve(job).then(r => {
        it.thumbBusy = false;
        if (it.kind === 'pdf') { it.pages = r.pages; it.thumbUrl = URL.createObjectURL(r.blob); }
        else it.thumbUrl = URL.createObjectURL(r);
        if (card.isConnected) {
          show(it.thumbUrl);
          card.querySelector('.meta').textContent = metaText(it);
          if (it.kind === 'heic') loadNatural(card, it);
        }
      }).catch((e) => {
        it.thumbBusy = false;
        if (tile && card.isConnected) tile.textContent =
          it.kind === 'pdf' ? (e && e.name === 'PasswordException' ? 'PDF · password-protected' : 'PDF · preview unavailable')
          : it.kind === 'heic' ? 'HEIC · couldn’t decode this file'
          : '▶ Video · preview unavailable in this browser';
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
    if (f.mode === 'gif') return f.hit
      ? 'Target met: ' + fmtSize(f.achievedBytes) + ' ≤ ' + fmtSize(f.targetBytes) + ' (GIF fitted by shrinking dimensions' + (f.scale < 1 ? ' to ' + Math.round(f.scale * 100) + '%' : '') + ').'
      : 'Couldn’t reach ' + fmtSize(f.targetBytes) + ' — the smallest GIF we got was ' + fmtSize(f.achievedBytes) + '.';
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
        if (r.fit.legibility === 'low') {
          const warn = document.createElement('p');
          warn.className = 'warn-legible';
          warn.textContent = '⚠ This may be rejected as blurred — consider a bigger target or a sharper scan.';
          resultsEl.appendChild(warn);
        }
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

  /* ---------- Form / Exam Mode ---------- */
  const formPresetSel = document.getElementById('formPreset');
  const formCustomEl = document.getElementById('formCustom');
  const formHint = document.getElementById('formHint');
  const formDrop = document.getElementById('formDrop');
  const formInput = document.getElementById('formFileInput');
  const formCardsEl = document.getElementById('formCards');
  let formItems = [], formSeq = 0;

  formPresetSel.innerHTML = R.FORM_PRESETS.map(p => '<option value="' + p.id + '">' + p.label + '</option>').join('') +
    '<option value="custom">Custom window…</option>';

  function currentFormSpec() {
    const id = formPresetSel.value;
    if (id !== 'custom') return R.FORM_PRESETS.find(p => p.id === id);
    const num = (el, d) => { const v = parseFloat(document.getElementById(el).value); return isNaN(v) ? d : v; };
    return { id: 'custom', label: 'Custom', type: document.getElementById('fcType').value,
      minKB: num('fcMin', 0), maxKB: Math.max(1, num('fcMax', 50)), width: num('fcW', 0), height: num('fcH', 0) };
  }
  function paintFormHint() {
    const s = currentFormSpec();
    formCustomEl.hidden = formPresetSel.value !== 'custom';
    if (s.type === 'doc') formHint.textContent = 'Every file becomes its OWN PDF of at most ' + s.maxKB + ' KB — add each certificate separately, exactly like the portal asks.';
    else if (s.width > 0) formHint.textContent = 'JPG · must land between ' + s.minKB + '–' + s.maxKB + ' KB · exactly ' + s.width + ' × ' + s.height + ' px. The photo is cropped to the box, never stretched — drag the preview to move the crop.';
    else formHint.textContent = 'JPG · must land between ' + s.minKB + '–' + s.maxKB + ' KB · the photo keeps its own shape.';
  }
  formPresetSel.addEventListener('change', () => { paintFormHint(); rerunFormItems(); });
  formCustomEl.addEventListener('change', () => { paintFormHint(); rerunFormItems(); });
  formDrop.addEventListener('click', () => formInput.click());
  formDrop.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); formInput.click(); } });
  formInput.addEventListener('change', () => { addFormFiles([...formInput.files]); formInput.value = ''; });
  ['dragenter', 'dragover'].forEach(ev => formDrop.addEventListener(ev, e => { e.preventDefault(); formDrop.classList.add('over'); }));
  ['dragleave', 'drop'].forEach(ev => formDrop.addEventListener(ev, e => { e.preventDefault(); formDrop.classList.remove('over'); }));
  formDrop.addEventListener('drop', e => addFormFiles([...e.dataTransfer.files]));

  function addFormFiles(files) {
    for (const f of files) formItems.push({ id: ++formSeq, file: f, kind: R.classify(f), cropX: 0.5, cropY: 0.5, status: 'ready', results: [], error: '' });
    renderFormCards();
    for (const it of formItems) if (it.status === 'ready') runFormItem(it);
  }
  function rerunFormItems() {
    for (const it of formItems) it.status = 'ready';
    renderFormCards();
    for (const it of formItems) runFormItem(it);
  }

  const kbText = (b) => (b / 1024).toFixed(b >= 10240 ? 0 : 1) + ' KB';
  function formCheck(it, r) {
    const f = r.fit, s = it.spec;
    if (s.type === 'image') {
      const dims = s.width > 0 ? f.width + ' × ' + f.height + ' px · ' : '';
      return f.hit
        ? { ok: true, text: '✓ ' + dims + kbText(f.achievedBytes) + ' — inside ' + s.minKB + '–' + s.maxKB + ' KB' + (f.padded ? ' (padded to clear the minimum)' : '') }
        : { ok: false, text: '✗ Closest we got: ' + kbText(f.achievedBytes) + ' — outside the ' + s.minKB + '–' + s.maxKB + ' KB window' };
    }
    return f.hit
      ? { ok: true, text: '✓ ' + kbText(f.achievedBytes) + ' — under the ' + s.maxKB + ' KB cap · saved as its own PDF' }
      : { ok: false, text: '✗ Smallest we got: ' + kbText(f.achievedBytes) + ' — still over the ' + s.maxKB + ' KB cap' };
  }

  function renderFormCards() {
    formCardsEl.innerHTML = '';
    for (const it of formItems) {
      const card = document.createElement('article');
      card.className = 'card form-card'; card.dataset.id = it.id;
      const extTag = (R.extOf(it.file.name) || 'file').toUpperCase();
      const kindLabel = it.kind ? R.KINDS[it.kind].label : 'Unknown type';
      card.innerHTML =
        '<div class="card-head"><span class="icon-tile kind-' + (it.kind || 'unknown') + '" aria-hidden="true">' + extTag + '</span>' +
        '<span class="fname-wrap"><strong class="fname"></strong><span class="meta">' + kindLabel + ' · ' + fmtSize(it.file.size) + '</span></span>' +
        '<button class="x" title="Remove">✕</button></div>' +
        '<div class="form-preview"></div>' +
        '<div class="form-status"></div>' +
        '<div class="results"></div>';
      card.querySelector('.fname').textContent = it.file.name;
      card.querySelector('.x').addEventListener('click', () => {
        if (it.srcUrl) URL.revokeObjectURL(it.srcUrl);
        formItems = formItems.filter(x => x !== it); renderFormCards();
      });
      formCardsEl.appendChild(card);
      wireFormPreview(card, it);
      if (it.status === 'done') paintFormResults(it, card);
      if (it.status === 'error') paintFormError(it, card);
    }
  }

  function wireFormPreview(card, it) {
    const holder = card.querySelector('.form-preview');
    if (it.kind === 'pdf') { holder.innerHTML = '<span class="thumb-tile">PDF · ' + it.file.name + '</span>'; return; }
    if (!isImg(it.kind)) { holder.innerHTML = '<span class="thumb-tile">' + (R.extOf(it.file.name) || 'file').toUpperCase() + ' file</span>'; return; }
    holder.innerHTML = '<span class="thumb-tile">Loading preview…</span>';
    window.SabConvert.previewSource(it.file).then(blob => {
      if (!card.isConnected) return;
      if (!it.srcUrl) it.srcUrl = URL.createObjectURL(blob);
      holder.innerHTML = '';
      const wrap = document.createElement('span'); wrap.className = 'crop-wrap';
      const img = document.createElement('img'); img.className = 'form-thumb'; img.alt = 'Preview — drag to reposition the crop';
      img.src = it.srcUrl;
      wrap.appendChild(img);
      const spec = currentFormSpec();
      if (spec.type === 'image' && spec.width > 0) {
        const frame = document.createElement('span'); frame.className = 'crop-frame';
        wrap.appendChild(frame);
        const place = () => {
          const iw = img.clientWidth, ih = img.clientHeight;
          if (!iw || !it.natural) return;
          const ta = spec.width / spec.height, sa = it.natural.width / it.natural.height;
          let cw, ch;
          if (sa > ta) { ch = ih; cw = ih * ta; } else { cw = iw; ch = iw / ta; }
          frame.style.width = cw + 'px'; frame.style.height = ch + 'px';
          frame.style.left = ((iw - cw) * it.cropX) + 'px'; frame.style.top = ((ih - ch) * it.cropY) + 'px';
        };
        wrap._place = place;
        img.addEventListener('load', place);
        if (img.complete) place();
        let drag = null;
        wrap.addEventListener('pointerdown', e => { drag = { x: e.clientX, y: e.clientY, fx: it.cropX, fy: it.cropY }; wrap.setPointerCapture(e.pointerId); });
        wrap.addEventListener('pointermove', e => {
          if (!drag) return;
          const iw = img.clientWidth, ih = img.clientHeight;
          const ta = spec.width / spec.height, sa = (it.natural ? it.natural.width / it.natural.height : iw / ih);
          const cw = sa > ta ? ih * ta : iw, ch = sa > ta ? ih : iw / ta;
          if (iw - cw > 0) it.cropX = Math.min(1, Math.max(0, drag.fx + (e.clientX - drag.x) / (iw - cw)));
          if (ih - ch > 0) it.cropY = Math.min(1, Math.max(0, drag.fy + (e.clientY - drag.y) / (ih - ch)));
          place();
        });
        wrap.addEventListener('pointerup', () => { if (drag) { drag = null; it.status = 'ready'; runFormItem(it); } });
      }
      holder.appendChild(wrap);
      if (!it.natural) window.SabConvert.imageInfo(it.file).then(d => { it.natural = d; if (wrap._place) wrap._place(); }).catch(() => {});
    }).catch(() => { if (card.isConnected) holder.innerHTML = '<span class="thumb-tile">Preview unavailable</span>'; });
  }

  async function runFormItem(it) {
    const card = formCardsEl.querySelector('.form-card[data-id="' + it.id + '"]');
    if (!card) return;
    const statusEl = card.querySelector('.form-status');
    statusEl.textContent = 'Fitting…'; statusEl.className = 'form-status';
    it.spec = currentFormSpec();
    try {
      it.results = await window.SabConvert.formFit(it.file, it.spec, { cropX: it.cropX, cropY: it.cropY });
      it.status = 'done'; it.error = '';
      paintFormResults(it, card);
    } catch (e) {
      it.status = 'error'; it.error = e.message || String(e); it.results = [];
      paintFormError(it, card);
    }
  }
  function paintFormError(it, card) {
    const statusEl = card.querySelector('.form-status');
    statusEl.textContent = ''; statusEl.className = 'form-status';
    const res = card.querySelector('.results');
    res.innerHTML = '';
    const p = document.createElement('p');
    p.className = 'form-check bad'; p.textContent = '✗ ' + it.error;
    res.appendChild(p);
  }
  function paintFormResults(it, card) {
    const statusEl = card.querySelector('.form-status');
    statusEl.textContent = ''; statusEl.className = 'form-status';
    const res = card.querySelector('.results');
    res.innerHTML = '';
    for (const r of it.results) {
      const row = document.createElement('div'); row.className = 'dl-row';
      const a = document.createElement('a');
      a.href = URL.createObjectURL(r.blob); a.download = r.name; a.className = 'dl';
      a.textContent = '⬇ ' + r.name;
      const sz = document.createElement('span');
      sz.className = 'sz'; sz.textContent = sizeDelta(it, r.blob.size);
      row.appendChild(a); row.appendChild(sz);
      res.appendChild(row);
      const chk = formCheck(it, r);
      const p = document.createElement('p');
      p.className = 'form-check ' + (chk.ok ? 'ok' : 'bad');
      p.textContent = chk.text;
      res.appendChild(p);
      if (r.fit && r.fit.legibility === 'low') {
        const warn = document.createElement('p');
        warn.className = 'warn-legible';
        warn.textContent = '⚠ This may be rejected as blurred — consider a bigger target or a sharper scan.';
        res.appendChild(warn);
      }
    }
  }

  paintFormHint();
  render();
})();
