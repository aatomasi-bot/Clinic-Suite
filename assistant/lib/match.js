// Duplicate check — follows VaPiq's own rule (index.html savePatient /
// importNotesPatients): the FILE NUMBER is the patient's identity. If it already
// exists, nothing is written; we only report it. A matching name under a
// different file number is shown as a warning on the approval card.

export const normFile = v => String(v ?? '').trim().toLowerCase();
const normName = v => String(v ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/[^a-z\s-]/g, ' ').replace(/\s+/g, ' ').trim();

export function patientStatus(p) {
  return p.archived ? 'On hold' : p.pending ? 'Pending' : 'Active';   // VaPiq's Archive is the "Hold" tab
}

// patients: [{ id, file_number, patient_name, archived, pending }]
export function findExisting(fileNumber, patients) {
  const k = normFile(fileNumber);
  if (!k) return null;
  return patients.find(p => normFile(p.file_number) === k) || null;
}

export function sameNameOtherFile(name, fileNumber, patients) {
  const n = normName(name);
  if (!n) return [];
  const k = normFile(fileNumber);
  return patients.filter(p => normName(p.patient_name) === n && normFile(p.file_number) !== k);
}
