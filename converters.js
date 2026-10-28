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

  const baseName = (name) => String(name || 'file').replace(/\.[^.]*$/, '');
  const out = (file, suffix, blob) => ({ name: baseName(file.name) + suffix, blob });
  const MIME = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp', bmp: 'image/bmp', gif: 'image/gif',
    pdf: 'application/pdf', txt: 'text/plain', html: 'text/html', json: 'application/json', csv: 'text/csv',
    xml: 'application/xml', zip: 'application/zip' };

  /* ---------------- images (Canvas) ---------------- */
  async function imageCanvas(file, o) {
    const bmp = await createImageBitmap(file);
    const rot = parseInt(o.rotate || '0', 10);
    const swap = rot === 90 || rot === 270;
    let w = bmp.width, h = bmp.height;
    const maxDim = parseInt(o.maxDim || '0', 10);
    if (maxDim > 0) { const m = Math.max(w, h); if (m > maxDim) { const s = maxDim / m; w = Math.round(w * s); h = Math.round(h * s); } }
    const cw = swap ? h : w, ch = swap ? w : h;
    const cv = document.createElement('canvas'); cv.width = cw; cv.height = ch;
    const ctx = cv.getContext('2d');
    if (o.grayscale) ctx.filter = 'grayscale(1)';
    ctx.translate(cw / 2, ch / 2); ctx.rotate(rot * Math.PI / 180);
    ctx.drawImage(bmp, -w / 2, -h / 2, w, h);
    bmp.close && bmp.close();
    return cv;
  }
  function canvasBlob(cv, type, q) {
    return new Promise((res, rej) => cv.toBlob(b => b ? res(b) : rej(new Error('canvas encode failed: ' + type)), type, q));
  }
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
  async function convImage(file, target, o) {
    const cv = await imageCanvas(file, o);
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

  /* ---------------- PDF ---------------- */
  async function pdfJsDoc(file) {
    const pdfjsLib = await ensurePdfJs();
    const data = new Uint8Array(await file.arrayBuffer());
    return pdfjsLib.getDocument({ data }).promise;
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
  async function convVideoFrame(file) {
    const v = await loadVideo(file);
    try {
      await seek(v, Math.min(1, (v.duration || 2) / 2));
      const cv = document.createElement('canvas'); cv.width = v.videoWidth; cv.height = v.videoHeight;
      cv.getContext('2d').drawImage(v, 0, 0);
      return [out(file, '-frame.jpg', await canvasBlob(cv, 'image/jpeg', 0.9))];
    } finally { URL.revokeObjectURL(v.src); }
  }
  async function convVideoToGif(file) {
    const GIF = await ensureGif();
    const v = await loadVideo(file);
    try {
      const dur = Math.min(v.duration || 1, 3), fps = 8, n = Math.max(2, Math.round(dur * fps));
      const scale = 320 / (v.videoWidth || 320);
      const cv = document.createElement('canvas');
      cv.width = 320; cv.height = Math.max(2, Math.round((v.videoHeight || 240) * Math.min(1, scale)));
      const ctx = cv.getContext('2d');
      const gif = new GIF({ workers: 2, quality: 12, width: cv.width, height: cv.height, workerScript: 'gif.worker.js' });
      for (let i = 0; i < n; i++) { await seek(v, (i / fps) + 0.01); ctx.drawImage(v, 0, 0, cv.width, cv.height); gif.addFrame(cv, { copy: true, delay: Math.round(1000 / fps) }); }
      const blob = await new Promise((res, rej) => { gif.on('finished', res); gif.on('abort', () => rej(new Error('gif aborted'))); gif.render(); });
      return [out(file, '.gif', blob)];
    } finally { URL.revokeObjectURL(v.src); }
  }

  /* ---------------- dispatcher ---------------- */
  const SC_CONVERTERS = {
    image: convImage, imageToPdf: convImageToPdf,
    pdfToImages: convPdfToImages, pdfToText: convPdfToText, pdfSplit: convPdfSplit, pdfExtract: convPdfExtract,
    table: convTable, subtitle: convSubtitle,
    zipPack: convZipPack, zipExtract: convZipExtract, b64Encode: convB64Encode, b64Decode: convB64Decode,
    videoFrame: convVideoFrame, videoToGif: convVideoToGif,
  };
  async function convert(file, target, options) {
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

  window.SabConvert = { convert, mergePdfs, registry: R, converters: SC_CONVERTERS,
    _test: { parseDelimited, emitTable, mdToHtml, mdToTxt, htmlToTxt, parseCues, emitCues, parsePageRange, encodeBMP } };
})();
