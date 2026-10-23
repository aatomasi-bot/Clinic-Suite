// Loads a PDF with the same pdf.js version the browser parser uses (3.11.174)
// and runs the shared Medicum parser (js/medicum-parse.js) on it.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

// pdf.js warns that it cannot polyfill canvas APIs; we only read text and
// drawing operators, never render, so silence that one-time warning.
const { log, warn } = console; console.log = console.warn = () => {};
const pdfjsLib = require('pdfjs-dist/legacy/build/pdf.js');
Object.assign(console, { log, warn });
const shared = require('../../js/medicum-parse.js');
import { ocrText } from './ocr.js';
export const repeatsFor = shared.repeatsFor;

export async function openPdf(bytes) {
  return pdfjsLib.getDocument({
    data: new Uint8Array(bytes),
    disableFontFace: true,
    isEvalSupported: false,
    verbosity: 0,
  }).promise;
}

// Returns { result, scanned, ocr, text }. scanned = no usable text layer
// (fax/image): then the Mac's own text recognition reads it (ocr: true), or
// result stays null when that isn't possible. `text` is only used in memory
// to recognise the document type; it is never stored.
export async function parsePdf(bytes, fname) {
  const pdf = await openPdf(bytes);
  let ex;
  try { ex = await shared.extractMedicumText(pdf, { OPS: pdfjsLib.OPS }); }
  finally { await pdf.destroy(); }
  const scanned = ex.txt.replace(/\s+/g, '').length <= 80;   // same threshold as medicum-parser.html
  if (!scanned) return { scanned, ocr: false, text: ex.txt, result: shared.parseMedicumPdf(ex, fname) };
  return parseScan(bytes, fname);
}

// A scan (PDF or picture) read by the Mac's text recognition.
export function parseScan(bytes, fname) {
  const o = ocrText(bytes, fname);
  if (!o || o.text.replace(/\s+/g, '').length <= 80) return { scanned: true, ocr: false, text: '', result: null };
  const r = shared.parseMedicum(o.text, [], fname);
  const rp = shared.repeatsFor(r.dose, r.injections, r.months);
  r.totalDoses = rp.total; r.totalWhy = rp.why; r.doseReason = r.dose ? 'read from the scan' : 'not found on the scan';
  return { scanned: true, ocr: true, text: o.text, result: r };
}
