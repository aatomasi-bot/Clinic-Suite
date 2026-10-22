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

export async function openPdf(bytes) {
  return pdfjsLib.getDocument({
    data: new Uint8Array(bytes),
    disableFontFace: true,
    isEvalSupported: false,
    verbosity: 0,
  }).promise;
}

// Returns { result, scanned } — scanned = no usable text layer (fax/image);
// those need OCR, which v1 leaves to the Medicum Parser page.
export async function parsePdf(bytes, fname) {
  const pdf = await openPdf(bytes);
  try {
    const ex = await shared.extractMedicumText(pdf, { OPS: pdfjsLib.OPS });
    const scanned = ex.txt.replace(/\s+/g, '').length <= 80;   // same threshold as medicum-parser.html
    return { scanned, result: scanned ? null : shared.parseMedicumPdf(ex, fname) };
  } finally {
    await pdf.destroy();
  }
}
