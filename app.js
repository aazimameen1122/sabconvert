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

  function optionControls(it) {
    if (it.kind === 'image') return '<div class="opts">' +
      '<label>Quality <input type="range" min="0.3" max="1" step="0.02" value="0.92" data-opt="quality"><span class="qv">0.92</span></label>' +
      '<label>Max size <select data-opt="maxDim"><option value="0">Original</option><option value="2048">2048px</option><option value="1024">1024px</option><option value="800">800px</option></select></label>' +
      '<label>Rotate <select data-opt="rotate"><option value="0">0°</option><option value="90">90°</option><option value="180">180°</option><option value="270">270°</option></select></label>' +
      '<label><input type="checkbox" data-opt="grayscale"> Grayscale</label></div>';
    if (it.kind === 'pdf') return '<div class="opts"><label>Pages for “Extract” <input type="text" data-opt="pages" placeholder="e.g. 1-2,4 (blank = page 1)" size="24"></label></div>';
    return '';
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
      const kindLabel = it.kind ? R.KINDS[it.kind].label : 'Unknown type';
      card.innerHTML =
        '<div class="card-head"><strong class="fname"></strong><span class="meta"></span>' +
        '<button class="x" title="Remove">✕</button></div>' +
        (it.kind ? '' : '<p class="warn">Format not in the converter list — you can still Base64-encode or ZIP it.</p>') +
        '<div class="row"><label>Convert to <select class="target">' +
        outs.map(o => '<option value="' + o.to + '"' + (o.to === it.target ? ' selected' : '') + '>' + o.label + '</option>').join('') +
        '</select></label>' +
        '<button class="primary convert">Convert</button>' +
        '<span class="status"></span></div>' +
        optionControls(it) +
        '<div class="results"></div>';
      card.querySelector('.fname').textContent = it.file.name;
      card.querySelector('.meta').textContent = kindLabel + ' · ' + fmtSize(it.file.size);
      const sel = card.querySelector('.target');
      const statusEl = card.querySelector('.status');
      const resultsEl = card.querySelector('.results');
      sel.addEventListener('change', () => { it.target = sel.value; });
      card.querySelectorAll('[data-opt]').forEach(el => {
        el.addEventListener('change', () => {
          const k = el.dataset.opt;
          it.options[k] = el.type === 'checkbox' ? el.checked : el.value;
          const qv = card.querySelector('.qv'); if (qv && k === 'quality') qv.textContent = el.value;
        });
        if (el.type === 'checkbox') it.options[el.dataset.opt] = el.checked;
        else it.options[el.dataset.opt] = el.value;
      });
      card.querySelector('.x').addEventListener('click', () => { items = items.filter(x => x !== it); render(); });
      card.querySelector('.convert').addEventListener('click', () => convertItem(it, statusEl, resultsEl));
      if (it.status === 'error') { statusEl.textContent = '✗ ' + it.error; statusEl.className = 'status err'; }
      if (it.status === 'done') paintResults(it, resultsEl, statusEl);
      cardsEl.appendChild(card);
    }
  }

  function paintResults(it, resultsEl, statusEl) {
    resultsEl.innerHTML = '';
    for (const r of it.results) {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(r.blob); a.download = r.name; a.className = 'dl';
      a.textContent = '⬇ ' + r.name + ' (' + fmtSize(r.blob.size) + ')';
      resultsEl.appendChild(a);
    }
    statusEl.textContent = '✓ done'; statusEl.className = 'status ok';
  }

  async function convertItem(it, statusEl, resultsEl) {
    statusEl.textContent = 'converting…'; statusEl.className = 'status';
    try {
      it.results = await window.SabConvert.convert(it.file, it.target, it.options);
      it.status = 'done'; it.error = '';
      paintResults(it, resultsEl, statusEl);
    } catch (e) {
      it.status = 'error'; it.error = e.message || String(e); it.results = [];
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
      const pdfs = items.filter(i => i.kind === 'pdf').map(i => i.file);
      const res = await window.SabConvert.mergePdfs(pdfs);
      mergeResultEl.innerHTML = '';
      for (const r of res) {
        const a = document.createElement('a');
        a.href = URL.createObjectURL(r.blob); a.download = r.name; a.className = 'dl';
        a.textContent = '⬇ ' + r.name + ' (' + fmtSize(r.blob.size) + ')';
        mergeResultEl.appendChild(a);
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
  document.getElementById('clearAll').addEventListener('click', () => { items = []; mergeResultEl.innerHTML = ''; render(); });

  render();
})();
