// Turns parser output into a proposed `patients` row (database column names),
// using the same defaults as VaPiq's own import (index.html importNotesPatients).
// Anything the parser could not find is listed in missingFields so the
// approval card highlights it — defaults are never silently trusted.

import { createRequire } from 'node:module';
const { formatAddress: sharedFormatAddress } = createRequire(import.meta.url)('../../js/medicum-parse.js');

const MONTHS = ['january','february','march','april','may','june','july','august','september','october','november','december'];
const pad = n => String(n).padStart(2, '0');

export function todayStr(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// Parser dates look like "15 November 2026"
export function toIsoDate(s) {
  const m = String(s || '').match(/^(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})$/);
  if (!m) return '';
  const mm = MONTHS.indexOf(m[2].toLowerCase());
  return mm < 0 ? '' : `${m[3]}-${pad(mm + 1)}-${pad(+m[1])}`;
}

// Same as medicum-parser.html: "street, city, prov, postal, Apt. 3" / "…, Unit C"
export const formatAddress = r => sharedFormatAddress(r);

// Default total doses when the form gives nothing (VaPiq's default).
const DEFAULT_TOTAL = '4';
export function buildRecord(parsed, { fileNumber, specialInstructions = '' } = {}) {
  const r = parsed || {};
  const missing = [];
  const due = toIsoDate(r.date);
  const address = formatAddress(r);
  if (!r.name) missing.push('Patient Name');
  if (!fileNumber) missing.push('File Number');
  if (!r.dose) missing.push('Dose Prescribed');
  if (!r.street) missing.push('Address');
  if (!r.ph1) missing.push('Phone 1');
  if (!due) missing.push('Due Date');
  const record = {
    patient_name:             r.name || '',
    file_number:              fileNumber || '',
    address,
    phone1:                   r.ph1 || '',
    phone2:                   r.ph2 || '',
    dose_prescribed:          r.dose || '',          // blank until confirmed (VaPiq default 22.5 is not assumed)
    total_doses:              r.totalDoses || DEFAULT_TOTAL,   // from the form (js/medicum-parse.js repeatsFor)
    doses_remaining:          r.totalDoses || DEFAULT_TOTAL,   // new patient: nothing given yet
    injection_site:           '',
    previous_injection_site:  '',
    due_date:                 due || todayStr(),
    appointment_date_time:    null,
    previous_injection_dates: '',
    assignment_type:          'Permanent',
    special_instructions:     specialInstructions,
    adverse_effects_comments: '',
    file_status:              'Active',
    injection_administered:   false,
    appointment_confirmed:    false,
    pending:                  false,
    archived:                 false,
    cpp_patient:              false,
  };
  return { record, missing };
}
