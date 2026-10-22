// Generates FAKE Medicum-style assignment PDFs (no real patient data) so the
// parser and the intake pipeline can be tested end to end.
//   node make-fake-pdfs.js            → test-inbox/   (PDF + .json email headers)
//   node make-fake-pdfs.js <dir>      → <dir>/
// Each form marks the selected dose a different way, mirroring what we see on
// real forms: ticked AcroForm checkbox, bold option, X in a box, filled box,
// underline, French decimals, nothing selected, and an image-only "scan".
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.resolve(process.argv[2] || path.join(here, 'test-inbox'));

const OPTIONS_EN = [['1-m', '7.5mg', '7.5'], ['3-m', '22.5mg', '22.5'], ['4-m', '30mg', '30'], ['6-m', '45mg', '45']];
const OPTIONS_FR = [['1 mois', '7,5 mg', '7.5'], ['3 mois', '22,5 mg', '22.5'], ['4 mois', '30 mg', '30'], ['6 mois', '45 mg', '45']];

// expected = what a correct parser must return; fileNumber 30001 also exists in
// test/fixtures/patients.json to exercise the "already exists" path.
export const CASES = [
  { id: 'fake-01-checkbox',   file: '39001', name: 'Jean Testpatient',    dose: '45',   mark: 'acroform' },
  { id: 'fake-02-bold',       file: '39002', name: 'Marie Exemple',       dose: '22.5', mark: 'bold' },
  { id: 'fake-03-xmark',      file: '39003', name: 'Paul Fictif',         dose: '30',   mark: 'x' },
  { id: 'fake-04-filled',     file: '39004', name: 'Lucie Demo',          dose: '7.5',  mark: 'filled' },
  { id: 'fake-05-underline',  file: '39005', name: 'Andre Essai',         dose: '45',   mark: 'underline' },
  { id: 'fake-06-french',     file: '39006', name: 'Sophie Factice',      dose: '22.5', mark: 'x', french: true },
  { id: 'fake-07-noselect',   file: '39007', name: 'Marc Vide',           dose: '',     mark: 'none' },
  { id: 'fake-08-exists',     file: '30001', name: 'Existing Testperson', dose: '30',   mark: 'bold' },
  { id: 'fake-09-scanned',    file: '39009', name: '',                    dose: '',     mark: 'scan' },
  { id: 'fake-10-checkbox17', file: '39010', name: 'Nina Cocher',         dose: '22.5', mark: 'acroform', trickyNames: true },
];

async function makeForm(c) {
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  const reg = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const black = rgb(0, 0, 0);

  if (c.mark === 'scan') {
    // No text layer at all — like a faxed/scanned image.
    page.drawRectangle({ x: 40, y: 40, width: 532, height: 712, borderColor: black, borderWidth: 1 });
    return doc.save();
  }

  let y = 740;
  const line = (label, value) => {
    page.drawText(label, { x: 40, y, size: 10, font: bold, color: black });
    if (value) page.drawText(value, { x: 230, y, size: 11, font: reg, color: black });
    y -= 26;
  };
  page.drawText('ELIGARD — INJECTION REQUEST / DEMANDE D\'INJECTION', { x: 40, y: 765, size: 13, font: bold });
  line('MEDICUM #:', c.file);
  line('PATIENT NAME/NOM DU PATIENT', c.name);
  line('ADDRESS/ADRESSE', '123 Rue Fictive Appartement 4');
  line('CITY/VILLE', 'Montreal, QC, H0H 0H0');
  line('TELEPHONE/TELEPHONE', '555-010-0001');
  line('SECONDARY CONTACT', 'Fille 555-010-0002');
  line('DATE OF BIRTH', '01/01/1950');
  line('DOCTOR NAME', 'Dr Fictif  TEL 555-010-0009  FAX 555-010-0008');
  line('PHARMACY #', '555-010-0007');
  line('INJECTION DUE DAY OF:', '15 November 2026');

  // Dose row
  page.drawText(c.french ? 'DOSE / POSOLOGIE' : 'DOSE', { x: 40, y, size: 10, font: bold });
  const opts = c.french ? OPTIONS_FR : OPTIONS_EN;
  const form = doc.getForm();
  opts.forEach(([lbl, mg, v], i) => {
    const x = 150 + i * 105, selected = v === c.dose;
    const text = `${lbl} (${mg})`;
    const font = c.mark === 'bold' && selected ? bold : reg;
    page.drawText(text, { x, y, size: 10, font });
    const bx = x - 14, by = y - 1;
    if (c.mark === 'acroform') {
      // Field names deliberately contain digits that the old name-regex misread
      const cb = form.createCheckBox(c.trickyNames ? `Check Box1${7 + i}` : `dose_${lbl}`);
      cb.addToPage(page, { x: bx, y: by, width: 10, height: 10 });
      if (selected) cb.check();
    } else if (c.mark !== 'none' && c.mark !== 'bold' && c.mark !== 'underline') {
      page.drawRectangle({ x: bx, y: by, width: 10, height: 10, borderColor: black, borderWidth: 0.8 });
      if (selected && c.mark === 'x') page.drawText('X', { x: bx + 2, y: by + 2, size: 9, font: bold });
      if (selected && c.mark === 'filled') page.drawRectangle({ x: bx + 2, y: by + 2, width: 6, height: 6, color: black });
    }
    if (c.mark === 'underline' && selected) {
      const w = font.widthOfTextAtSize(text, 10);
      page.drawLine({ start: { x, y: y - 2 }, end: { x: x + w, y: y - 2 }, thickness: 0.8, color: black });
    }
  });
  y -= 26;
  line('PRESCRIPTION DATE', '20/10/2026');
  return doc.save();
}

export async function writeFakeInbox(dir = outDir) {
  fs.mkdirSync(dir, { recursive: true });
  for (const c of CASES) {
    fs.writeFileSync(path.join(dir, `${c.id}.pdf`), await makeForm(c));
    fs.writeFileSync(path.join(dir, `${c.id}.json`), JSON.stringify({
      messageId: `<${c.id}@fake.local>`,
      from: 'Coordinator Test <coordinator.test@medicum.ca>',
      subject: c.mark === 'scan' ? `fax - XX #${c.file}` : `New patient ${c.file}`,
      date: '2026-10-20T15:00:00Z',
    }, null, 2));
  }
  return dir;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const dir = await writeFakeInbox();
  console.log(`Wrote ${CASES.length} fake assignment PDFs to ${dir}`);
}
