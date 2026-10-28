'use strict';
/*
 * SabConvert — route registry (single source of truth).
 * The UI builds its per-file format lists from this registry, and the
 * verification harness iterates exactly the same registry. If a route
 * is not listed here, the site does not claim it.
 *
 * Each output: { to, label, conv } — `conv` is a key into SC_CONVERTERS.
 */
(function () {
  const imgOut = [
    { to: 'jpg', label: 'JPG', conv: 'image' },
    { to: 'png', label: 'PNG', conv: 'image' },
    { to: 'webp', label: 'WebP', conv: 'image' },
    { to: 'bmp', label: 'BMP', conv: 'image' },
    { to: 'gif', label: 'GIF', conv: 'image' },
    { to: 'pdf', label: 'PDF', conv: 'imageToPdf' },
  ];
  const tableOut = [
    { to: 'csv', label: 'CSV', conv: 'table' },
    { to: 'tsv', label: 'TSV', conv: 'table' },
    { to: 'json', label: 'JSON', conv: 'table' },
    { to: 'xml', label: 'XML', conv: 'table' },
    { to: 'md', label: 'Markdown table', conv: 'table' },
    { to: 'html', label: 'HTML table', conv: 'table' },
  ];
  const KINDS = {
    image:   { label: 'Image',    exts: ['jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp', 'avif'], outputs: imgOut },
    pdf:     { label: 'PDF',      exts: ['pdf'], outputs: [
      { to: 'png', label: 'PNG (per page)', conv: 'pdfToImages' },
      { to: 'jpg', label: 'JPG (per page)', conv: 'pdfToImages' },
      { to: 'txt', label: 'TXT (text)', conv: 'pdfToText' },
      { to: 'split', label: 'Split into pages', conv: 'pdfSplit' },
      { to: 'extract', label: 'Extract pages → PDF', conv: 'pdfExtract' },
      { to: 'compress', label: 'Compress PDF (smaller)', conv: 'pdfCompress' },
    ] },
    csv:     { label: 'CSV table', exts: ['csv'], outputs: tableOut },
    tsv:     { label: 'TSV table', exts: ['tsv'], outputs: tableOut },
    json:    { label: 'JSON data', exts: ['json'], outputs: tableOut },
    txt:     { label: 'Text',     exts: ['txt'], outputs: [
      { to: 'html', label: 'HTML', conv: 'txtToHtml' },
      { to: 'pdf', label: 'PDF', conv: 'txtToPdf' },
    ] },
    md:      { label: 'Markdown', exts: ['md', 'markdown'], outputs: [
      { to: 'html', label: 'HTML', conv: 'mdToHtml' },
      { to: 'txt', label: 'TXT (plain)', conv: 'mdToTxt' },
      { to: 'pdf', label: 'PDF', conv: 'mdToPdf' },
    ] },
    html:    { label: 'HTML',     exts: ['html', 'htm'], outputs: [
      { to: 'txt', label: 'TXT', conv: 'htmlToTxt' },
    ] },
    docx:    { label: 'Word doc', exts: ['docx'], outputs: [
      { to: 'txt', label: 'TXT', conv: 'docxToTxt' },
      { to: 'html', label: 'HTML', conv: 'docxToHtml' },
    ] },
    srt:     { label: 'Subtitles (SRT)', exts: ['srt'], outputs: [
      { to: 'vtt', label: 'VTT', conv: 'subtitle' },
      { to: 'ass', label: 'ASS', conv: 'subtitle' },
    ] },
    vtt:     { label: 'Subtitles (VTT)', exts: ['vtt'], outputs: [
      { to: 'srt', label: 'SRT', conv: 'subtitle' },
      { to: 'ass', label: 'ASS', conv: 'subtitle' },
    ] },
    ass:     { label: 'Subtitles (ASS)', exts: ['ass', 'ssa'], outputs: [
      { to: 'srt', label: 'SRT', conv: 'subtitle' },
      { to: 'vtt', label: 'VTT', conv: 'subtitle' },
    ] },
    zip:     { label: 'ZIP archive', exts: ['zip'], outputs: [
      { to: 'extract', label: 'Extract files', conv: 'zipExtract' },
    ] },
    video:   { label: 'Video',    exts: ['mp4', 'webm', 'mov', 'm4v'], outputs: [
      { to: 'jpg', label: 'JPG (frame)', conv: 'videoFrame' },
      { to: 'gif', label: 'GIF (animated)', conv: 'videoToGif' },
    ] },
    b64:     { label: 'Base64 file', exts: ['b64'], outputs: [
      { to: 'decode', label: 'Decode Base64', conv: 'b64Decode' },
    ] },
  };
  // Offered for (almost) every file, on top of its kind outputs.
  const UNIVERSAL = [
    { to: 'b64', label: 'Base64 (.b64)', conv: 'b64Encode', universal: true },
    { to: 'zip', label: 'ZIP (pack)', conv: 'zipPack', universal: true },
  ];
  const GLOBAL_OPS = [
    { id: 'mergePdfs', label: 'Merge all PDFs into one', kind: 'pdf', min: 2 },
  ];

  function extOf(name) {
    const i = String(name || '').lastIndexOf('.');
    return i >= 0 ? String(name).slice(i + 1).toLowerCase() : '';
  }
  function classify(file) {
    const ext = extOf(file.name);
    for (const k of Object.keys(KINDS)) {
      if (KINDS[k].exts.includes(ext)) return k;
    }
    return null;
  }
  function outputsFor(kind) {
    if (!kind || !KINDS[kind]) return UNIVERSAL.slice();
    const own = KINDS[kind].outputs;
    return kind === 'zip' ? own.slice() : own.concat(UNIVERSAL);
  }
  function routeCount() {
    let n = 0;
    for (const k of Object.keys(KINDS)) n += KINDS[k].outputs.length;
    return n; // kind routes only; universal + global ops counted separately
  }

  window.SC_REGISTRY = { KINDS, UNIVERSAL, GLOBAL_OPS, classify, outputsFor, extOf, routeCount };
})();
