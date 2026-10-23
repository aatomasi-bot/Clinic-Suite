/* Medicum assignment-form parser, shared by medicum-parser.html (browser)
   and the intake assistant (assistant/, Node). Keep this file free of DOM
   access so both can load it.
     extractMedicumText(pdf) -> { txt, bold, dose:{value,reason} }   pdf = a pdf.js document
     parseMedicum(text, bold, fname) -> { name, file, dose, street, city,
                                          prov, postal, apt, ph1, ph2, date } */
(function (root) {
'use strict';

// ── PDF text + selected-dose detection ──────────────────────────────────
// The dose row lists four options — 1-m (7.5mg), 3-m (22.5mg), 4-m (30mg),
// 6-m (45mg) — and the selected one is marked in one of several ways. We
// locate the four options on the page, then look for a mark that singles out
// exactly ONE of them, strongest evidence first:
//   1. ticked AcroForm checkbox / radio next to an option
//   2. an X / ✓ / ☒ glyph in front of an option
//   3. a filled box in front of an option
//   4. an underline under an option
//   5. an option in a bold (or otherwise different) font than the others
// If nothing singles out one option — or two strong signals disagree — the dose
// is left blank and flagged rather than guessed.

const DOSE_VALUES = ['7.5', '22.5', '30', '45'];
const DOSE_MONTHS = { '7.5': '1', '22.5': '3', '30': '4', '45': '6' };
// "22.5mg", "22,5 mg", "22.5 MG" — French decimal comma included
const DOSE_RX = /(^|[^\d.,])(7[.,]5|22[.,]5|30|45)\s*mg\b/gi;
const MARK_GLYPH_RX = /^[\sXx✓✔✗✘☒☑■●◼▪⊠]+$/;

function _normDose(s) { return s.replace(',', '.'); }

// pdf.js text items hold an internal font id (g_d0_f1). After
// getOperatorList() the real font (e.g. "ABCDEF+Arial-BoldMT") is available.
function _fontInfo(page, id) {
  try {
    if (page.commonObjs.has(id)) {
      const f = page.commonObjs.get(id);
      const name = String((f && f.name) || '');
      return { name, bold: !!(f && (f.bold || f.black)) || /Bold|Heavy|Black|Semibold|Demi|,B\b|-B\b|Bd\b/i.test(name) };
    }
  } catch (e) {}
  return { name: id, bold: /Bold|Heavy|Black|Bd/i.test(id) };
}

function _mul(m1, m2) {
  return [m1[0]*m2[0] + m1[2]*m2[1], m1[1]*m2[0] + m1[3]*m2[1],
          m1[0]*m2[2] + m1[2]*m2[3], m1[1]*m2[2] + m1[3]*m2[3],
          m1[0]*m2[4] + m1[2]*m2[5] + m1[4], m1[1]*m2[4] + m1[3]*m2[5] + m1[5]];
}
function _pt(m, x, y) { return [m[0]*x + m[2]*y + m[4], m[1]*x + m[3]*y + m[5]]; }

// Painted shapes (lines, rectangles) in page space, from the operator list.
function _shapes(opList, OPS) {
  const out = [];
  if (!OPS) return out;
  let ctm = [1, 0, 0, 1, 0, 0];
  const stack = [];
  let fill = '#000000';
  let pending = [];
  const paintFill = new Set([OPS.fill, OPS.eoFill, OPS.fillStroke, OPS.eoFillStroke, OPS.closeFillStroke, OPS.closeEOFillStroke]);
  const paintStroke = new Set([OPS.stroke, OPS.closeStroke]);
  const hex = a => typeof a[0] === 'string' ? a[0]
    : '#' + a.slice(0, 3).map(v => Math.round((v <= 1 ? v * 255 : v)).toString(16).padStart(2, '0')).join('');
  for (let i = 0; i < opList.fnArray.length; i++) {
    const fn = opList.fnArray[i], args = opList.argsArray[i];
    if (fn === OPS.save) stack.push([ctm, fill]);
    else if (fn === OPS.restore) { const s = stack.pop(); if (s) { ctm = s[0]; fill = s[1]; } }
    else if (fn === OPS.transform) ctm = _mul(ctm, args);
    else if (fn === OPS.setFillRGBColor) fill = hex(args);
    else if (fn === OPS.setFillGray) fill = hex([args[0], args[0], args[0]]);
    else if (fn === OPS.constructPath) {
      const ops = args[0], co = args[1];
      let k = 0, cur = null, sub = [];
      // A closed outline (move/line…/close) is a box, same as a rectangle op.
      const endSub = () => {
        if (sub.length >= 3) {
          const xs = sub.map(p => p[0]), ys = sub.map(p => p[1]);
          pending.push({ kind: 'rect', x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) });
        }
        sub = [];
      };
      for (const op of ops) {
        if (op === OPS.rectangle) {
          const [x, y, w, h] = co.slice(k, k + 4); k += 4;
          const a = _pt(ctm, x, y), b = _pt(ctm, x + w, y + h);
          pending.push({ kind: 'rect', x0: Math.min(a[0], b[0]), x1: Math.max(a[0], b[0]), y0: Math.min(a[1], b[1]), y1: Math.max(a[1], b[1]) });
        } else if (op === OPS.moveTo) { endSub(); cur = _pt(ctm, co[k], co[k + 1]); k += 2; sub = [cur]; }
        else if (op === OPS.lineTo) {
          const p = _pt(ctm, co[k], co[k + 1]); k += 2;
          if (cur) pending.push({ kind: 'line', x0: Math.min(cur[0], p[0]), x1: Math.max(cur[0], p[0]), y0: Math.min(cur[1], p[1]), y1: Math.max(cur[1], p[1]), diag: Math.abs(p[0]-cur[0]) > 1 && Math.abs(p[1]-cur[1]) > 1 });
          cur = p; sub.push(p);
        } else if (op === OPS.curveTo) { cur = _pt(ctm, co[k + 4], co[k + 5]); k += 6; sub.push(cur); }
        else if (op === OPS.curveTo2 || op === OPS.curveTo3) { cur = _pt(ctm, co[k + 2], co[k + 3]); k += 4; sub.push(cur); }
        else if (op === OPS.closePath) endSub();
      }
      endSub();
    } else if (paintFill.has(fn) || paintStroke.has(fn)) {
      const filled = paintFill.has(fn);
      for (const s of pending) out.push(Object.assign(s, { filled, fill }));
      pending = [];
    } else if (fn === OPS.endPath) pending = [];
  }
  return out;
}

// Locate the four dose options: the tightest cluster containing all four values.
function _findOptions(items) {
  const occ = [];
  for (const it of items) {
    const s = it.str; DOSE_RX.lastIndex = 0; let m;
    while ((m = DOSE_RX.exec(s))) {
      const start = m.index + m[1].length, len = m[0].length - m[1].length;
      const cw = s.length ? it.width / s.length : 0;
      occ.push({ value: _normDose(m[2]), item: it,
        x0: it.x + cw * start, x1: it.x + cw * (start + len), y0: it.y - it.size * 0.25, y1: it.y + it.size * 0.85 });
    }
  }
  const byVal = v => occ.filter(o => o.value === v);
  let best = null;
  for (const a of byVal('7.5')) {
    const pick = [a];
    for (const v of ['22.5', '30', '45']) {
      const c = byVal(v).sort((p, q) => Math.hypot(p.x0 - a.x0, p.y0 - a.y0) - Math.hypot(q.x0 - a.x0, q.y0 - a.y0))[0];
      if (!c) return null;
      pick.push(c);
    }
    const spread = pick.reduce((t, o) => t + Math.hypot(o.x0 - a.x0, o.y0 - a.y0), 0);
    if (!best || spread < best.spread) best = { spread, pick };
  }
  if (!best) return null;
  const opts = best.pick;
  // Extend each option to include its "N-m" / "N mois" label when that is a
  // separate text item just to the left on the same line.
  for (const o of opts) {
    const mo = DOSE_MONTHS[o.value];
    const lab = items.find(it => it !== o.item && Math.abs(it.y - o.item.y) < 3 && it.x < o.x0 && o.x0 - (it.x + it.width) < 25
      && new RegExp('^\\s*' + mo + '\\s*-?\\s*m', 'i').test(it.str));
    if (lab) o.x0 = Math.min(o.x0, lab.x);
    else {
      // label inside the same item ("3-m (22.5mg)")
      const s = o.item.str, cw = s.length ? o.item.width / s.length : 0;
      const idx = s.search(new RegExp(mo + '\\s*-?\\s*m(?:ois|onths?)?\\b', 'i'));
      if (idx >= 0) o.x0 = Math.min(o.x0, o.item.x + cw * idx);
    }
  }
  return opts;
}

// Gap between an option and the next option to its left on the same row
// (marks/boxes sit in front of an option, never beyond the previous one).
function _leftLimit(o, opts) {
  let lim = o.x0 - 30;
  for (const p of opts) if (p !== o && Math.abs(p.y0 - o.y0) < 4 && p.x1 <= o.x0) lim = Math.max(lim, p.x1);
  return lim;
}
const _vOverlap = (a, o) => Math.min(a.y1, o.y1 + 2) - Math.max(a.y0, o.y0 - 2) > 0;
const _inFront = (a, o, opts) => _vOverlap(a, o) && a.x1 <= o.x0 + 2 && a.x0 >= _leftLimit(o, opts) - 2;

function _unique(opts, test) {
  const hits = opts.filter(test);
  return hits.length === 1 ? hits[0].value : null;
}

function _detectDose(items, annots, shapes) {
  const opts = _findOptions(items);
  if (!opts) return { value: '', reason: 'dose options not found' };
  const signals = [];

  // 1. AcroForm checkboxes / radio buttons, matched by position (not by name)
  const checked = annots.filter(a => a.fieldType === 'Btn' && a.rect && (
    (a.checkBox && a.fieldValue && a.fieldValue !== 'Off' && (!a.exportValue || a.fieldValue === a.exportValue)) ||
    (a.radioButton && a.fieldValue && a.fieldValue === a.buttonValue)))
    .map(a => ({ x0: Math.min(a.rect[0], a.rect[2]), x1: Math.max(a.rect[0], a.rect[2]), y0: Math.min(a.rect[1], a.rect[3]), y1: Math.max(a.rect[1], a.rect[3]) }));
  const anyBoxField = annots.some(a => a.fieldType === 'Btn' && a.rect && opts.some(o => _inFront({
    x0: Math.min(a.rect[0], a.rect[2]), x1: Math.max(a.rect[0], a.rect[2]), y0: Math.min(a.rect[1], a.rect[3]), y1: Math.max(a.rect[1], a.rect[3]) }, o, opts)));
  const v1 = _unique(opts, o => checked.some(b => _inFront(b, o, opts)));
  if (v1) signals.push({ value: v1, reason: 'ticked checkbox', strong: true });

  // 2. X / ✓ glyph in front of an option
  const glyphs = items.filter(it => MARK_GLYPH_RX.test(it.str) && it.str.trim()).map(it => ({ x0: it.x, x1: it.x + it.width, y0: it.y - 1, y1: it.y + it.size * 0.8 }));
  const v2 = _unique(opts, o => glyphs.some(g => _inFront(g, o, opts)));
  if (v2) signals.push({ value: v2, reason: 'X/✓ mark', strong: true });

  // 3. filled box (or crossed box: two diagonals) in front of an option
  const small = s => (s.x1 - s.x0) < 16 && (s.y1 - s.y0) < 16;
  const dark = s => !/^#(f[0-9a-f]){3}$|^#ffffff$/i.test(s.fill || '');
  const v3 = _unique(opts, o =>
    shapes.some(s => s.kind === 'rect' && s.filled && dark(s) && small(s) && (s.x1 - s.x0) > 2 && _inFront(s, o, opts)) ||
    shapes.filter(s => s.kind === 'line' && s.diag && small(s) && _inFront(s, o, opts)).length >= 2);
  if (v3) signals.push({ value: v3, reason: 'filled/crossed box', strong: true });

  // 4. underline: a horizontal stroke just below the option's baseline
  const v4 = _unique(opts, o => shapes.some(s => {
    const h = s.y1 - s.y0, w = s.x1 - s.x0;
    if (h > 2.5 || w < (o.x1 - o.x0) * 0.4) return false;
    const base = o.item.y, below = base - s.y1;
    const overlap = Math.min(s.x1, o.x1) - Math.max(s.x0, o.x0);
    return below >= -1 && below <= 6 && overlap > (o.x1 - o.x0) * 0.5;
  }));
  if (v4) signals.push({ value: v4, reason: 'underline', strong: false });

  // 5. bold / different font among the four options
  const v5 = _unique(opts, o => o.item.bold) ;
  if (v5) signals.push({ value: v5, reason: 'bold option', strong: false });
  else {
    const fonts = opts.map(o => o.item.font);
    const v6 = _unique(opts, o => fonts.filter(f => f === o.item.font).length === 1 && new Set(fonts).size === 2);
    if (v6) signals.push({ value: v6, reason: 'different font', strong: false });
  }

  if (!signals.length) return { value: '', reason: anyBoxField ? 'no box ticked' : 'no option marked' };
  const strong = signals.filter(s => s.strong);
  const lead = strong[0] || signals[0];
  const conflict = signals.find(s => s.value !== lead.value && (s.strong || !strong.length));
  if (conflict) return { value: '', reason: `conflicting marks (${lead.reason}: ${lead.value} vs ${conflict.reason}: ${conflict.value})` };
  return { value: lead.value, reason: lead.reason };
}

// Months written next to the chosen option on the same row ("3-m (22.5mg) 18"):
// a 1–2 digit number after the option, before the next option. '' if none.
function _monthsNextTo(items, value) {
  const opts = _findOptions(items);
  const o = opts && opts.find(p => p.value === value);
  if (!o) return '';
  const next = opts.filter(p => p !== o && Math.abs(p.item.y - o.item.y) < 4 && p.x0 > o.x1).sort((a, b) => a.x0 - b.x0)[0];
  const limit = next ? next.x0 - 2 : o.x1 + 90;
  // inside the option's own text item, after "(22.5mg)"
  const own = o.item.str, cw = own.length ? o.item.width / own.length : 0;
  const tail = own.slice(Math.round((o.x1 - o.item.x) / (cw || 1)));
  const inOwn = tail.match(/^\s*\)?\s*[x×:]?\s*(\d{1,2})\b(?!\s*-?\s*m\b|\s*[.,]\d|\s*mg)/i);
  if (inOwn) return inOwn[1];
  const near = items.filter(it => it !== o.item && Math.abs(it.y - o.item.y) < 4 && it.x >= o.x1 - 1 && it.x < limit)
    .sort((a, b) => a.x - b.x).map(it => it.str.trim()).join(' ');
  const m = near.match(/^\)?\s*[x×:]?\s*(\d{1,2})\s*(?:m|mois|months?)?\b(?!\s*-?\s*m\b\s*\()/i);
  return m ? m[1] : '';
}

// Total doses (repeats) — confirmed Oct 23, 2026:
//   "Number of injections" filled on the form → that number;
//   else months marked next to the dose ÷ the dose's months
//   (7.5 mg = 1 month, 22.5 mg = 3, 30 mg = 4, 45 mg = 6): 22.5 mg + 18 → 6.
//   Nothing usable → '' (the caller keeps its default).
function repeatsFor(dose, injections, months) {
  const n = parseInt(injections, 10);
  if (n >= 1 && n <= 60) return { total: String(n), why: 'number of injections on the form' };
  const per = parseInt(DOSE_MONTHS[dose], 10), mo = parseInt(months, 10);
  if (!per || !(mo >= 1 && mo <= 72)) return { total: '', why: '' };
  if (mo % per) return { total: '', why: `${mo} months does not divide by ${per} (${dose} mg) — check the total doses` };
  return { total: String(mo / per), why: `${mo} months ÷ ${per} (${dose} mg)` };
}

async function extractMedicumText(pdf, opts){
    const OPS = (opts && opts.OPS) || (root.pdfjsLib && root.pdfjsLib.OPS) || null;
    let txt='';
    let dose={ value:'', reason:'dose options not found' };
    let months='';

    for(let i=1;i<=pdf.numPages;i++){
      const pg=await pdf.getPage(i);
      let opList={ fnArray:[], argsArray:[] }, annots=[];
      try{ opList=await pg.getOperatorList(); }catch(e){}
      try{ annots=await pg.getAnnotations(); }catch(e){}
      const tc=await pg.getTextContent();
      const fontCache={};
      const items=[];
      for(const item of tc.items){
        if(!item.str||!item.str.trim())continue;
        txt+=item.str+' ';
        const t=item.transform||[1,0,0,1,0,0];
        const f=fontCache[item.fontName]||(fontCache[item.fontName]=_fontInfo(pg,item.fontName));
        items.push({ str:item.str, x:t[4], y:t[5], width:item.width||0, size:Math.hypot(t[2],t[3])||Math.abs(t[3])||10,
                     font:f.name, bold:f.bold });
      }
      // Only the first page that has a dose row decides
      if(!dose.value && dose.reason==='dose options not found'){
        dose=_detectDose(items, annots, _shapes(opList, OPS));
        if(dose.value) months=_monthsNextTo(items, dose.value);
      }
    }
    // parseMedicum() reads the dose from `bold`; give it exactly the detected
    // dose (or nothing, so its text fallbacks run).
    const bold=dose.value?[dose.value+' mg']:[];
    return {txt,bold,dose,months};
}

// ── Address helpers ─────────────────────────────────────────────────────
// VaPiq address format: "street, city, prov, postal, <unit>", e.g.
//   "123 Boulevard Deguire, Montreal, QC, H4M 0A4, Apt. 3"
//   "45 Graham Boulevard, Laval, QC, H7G 3A4, Unit C"
// The unit keeps the label written on the form (Apt. / Unit / Suite).
const UNIT_LABELS=[
  {label:'Apt.',  rx:'Appartement|Apartment|Appt\\.?|Apt\\.?|App\\.?|Logement|Log\\.'},
  {label:'Unit',  rx:'Unit[ée]?|Unite'},
  {label:'Suite', rx:'Suite|Bureau'},
];
// "Unit C" → "Unit C", "appartement 703" → "Apt. 703", "3" → "Apt. 3"
function formatUnit(v){
  v=String(v||'').trim().replace(/^[,#\s]+/,'');
  if(!v)return'';
  for(const{label,rx}of UNIT_LABELS){
    const m=v.match(new RegExp('^(?:'+rx+')\\s*[:#]?\\s*(.+)$','i'));
    if(m)return label+' '+m[1].trim().toUpperCase();
  }
  return 'Apt. '+v.toUpperCase();
}
// Pulls the apartment/unit out of a street line:
//   "1 Boulevard X Appartement 703" · "45 Graham Boulevard, Unit C" · "12 Rue Y #5" · "3-123 Rue Z"
function splitUnit(street){
  let s=String(street||'').replace(/\s+/g,' ').trim(), unit='';
  for(const{label,rx}of UNIT_LABELS){
    const m=s.match(new RegExp('[,\\s]*\\b(?:'+rx+')(?![a-z])\\s*[:#]?\\s*([A-Za-z0-9-]{1,6})\\b','i'));
    if(m){unit=label+' '+m[1].toUpperCase();s=(s.slice(0,m.index)+' '+s.slice(m.index+m[0].length));break;}
  }
  if(!unit){
    const h=s.match(/\s*#\s*([A-Za-z0-9-]{1,6})\s*$/);              // "12 Rue Y #5"
    if(h){unit='Apt. '+h[1].toUpperCase();s=s.slice(0,h.index);}
  }
  if(!unit){
    const q=s.match(/^([A-Za-z0-9]{1,5})\s*-\s*(\d+[A-Za-z]?)\s+(?=\D)/); // Quebec "3-123 Rue Z" = unit 3, civic 123
    if(q){unit='Apt. '+q[1].toUpperCase();s=q[2]+' '+s.slice(q[0].length);}
  }
  s=s.replace(/\s+,/g,',').replace(/\s{2,}/g,' ').replace(/^[,\s]+|[,\s]+$/g,'');
  return {street:s,unit};
}
function formatAddress(r){
  return [r.street,r.city,r.prov,r.postal,formatUnit(r.apt)].map(x=>String(x||'').trim()).filter(Boolean).join(', ');
}

// ─────────────────────────────────────────────────────────────
// PARSER — built from actual Medicum form OCR text
// OCR sample: "33631 7.5 mg 290 54e Avenue CITY/VILLE Montréal,
//   QC, H8T 3A3 TELEPHONE/TELEPHONE 438 351-4765 SECONDARY
//   CONTACT ... 514 817-7388 DATE OF BIRTH 04/11/2017
//   INJECTION DUE DAY OF: [date or blank/ASAP]
//   PRESCRIPTION DATE 05/11/2026  MEDICUM #: 33631"
// ─────────────────────────────────────────────────────────────
function parse(text, bold, fname){
  const r={name:'',file:'',dose:'',street:'',city:'',prov:'QC',
           postal:'',apt:'',ph1:'',ph2:'',date:''};

  // ── helpers ────────────────────────────────────────────────
  function fmtPh(raw){
    if(!raw)return'';
    const d=raw.replace(/\D/g,'');
    if(d.length===10)return d.slice(0,3)+'-'+d.slice(3,6)+'-'+d.slice(6);
    if(d.length===11&&d[0]==='1')return d.slice(1,4)+'-'+d.slice(4,7)+'-'+d.slice(7);
    return'';
  }
  const MO_EN=['January','February','March','April','May','June',
               'July','August','September','October','November','December'];
  const MO_FR=['Janvier','Février','Mars','Avril','Mai','Juin',
               'Juillet','Août','Septembre','Octobre','Novembre','Décembre'];
  const MO_FR2=['janvier','fevrier','mars','avril','mai','juin',
                'juillet','aout','septembre','octobre','novembre','decembre'];
  function fmtDate(raw){
    if(!raw)return'';
    raw=raw.trim();
    // "21 Avril 2026" or "21 April 2026" format
    const wordy=raw.match(/(\d{1,2})\s+([A-Za-z\u00C0-\u00FF]+)\s+(\d{4})/);
    if(wordy){
      const dd=+wordy[1], mon=wordy[2], yy=+wordy[3];
      let mm=-1;
      MO_EN.forEach((m,i)=>{if(m.toLowerCase()===mon.toLowerCase())mm=i;});
      MO_FR.forEach((m,i)=>{if(m.toLowerCase()===mon.toLowerCase())mm=i;});
      MO_FR2.forEach((m,i)=>{if(mon.toLowerCase().startsWith(m.slice(0,4)))mm=i;});
      if(mm>=0)return dd+' '+MO_EN[mm]+' '+yy;
    }
    // "MM/DD/YYYY" or "DD/MM/YYYY"
    const slashed=raw.match(/(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})/);
    if(slashed){
      let a=+slashed[1],b=+slashed[2],c=+slashed[3];
      if(c<100)c+=2000;
      let mm,dd;
      if(a>12&&b<=12){mm=b;dd=a;}else{mm=a;dd=b;}
      if(mm<1||mm>12||dd<1||dd>31||c<2000)return'';
      return dd+' '+MO_EN[mm-1]+' '+c;
    }
    return'';
  }

  // ── 1. FILE NUMBER ─────────────────────────────────────────
  // "MEDICUM #: 33243"
  const fm=text.match(/MEDICUM\s*#\s*:?\s*(\d{3,8})/i)
          ||text.match(/FILE\s*(?:NUMBER|NO|#)\s*:?\s*([A-Z0-9\-]{3,10})/i);
  if(fm)r.file=fm[1].trim();
  if(!r.file){const fn=fname.replace(/\.pdf$/i,'').match(/(\d{4,8})/);if(fn)r.file=fn[1];}

  // ── 2. PATIENT NAME ────────────────────────────────────────
  // Form table: "PATIENT NAME/NOM DU PATIENT | Marc BALOR **"
  // OCR reads this as: "PATIENT NAME/NOM DU PATIENT Marc BALOR **"
  // Strategy 1: text starts with "Marc BALOR 33243," (name + file# at top)
  const startM=text.match(/^([A-Z][a-z\u00C0-\u00FF]+(?:\s+[A-Z][A-Za-z\u00C0-\u00FF\-]+)+)\s+\d{3,8}[,\s]/);
  if(startM&&!/PATIENT|MEDICUM|ADDRESS|TELEPHONE|LOGO|ELIGARD/i.test(startM[1])){
    r.name=startM[1].replace(/[*#@!?]+/g,'').replace(/\s+/g,' ').trim();
  }
  // Strategy 2: explicit PATIENT NAME label in table row
  if(!r.name){
    const nameLbl=text.match(/PATIENT\s+NAME\s*\/\s*NOM\s+DU\s+PATIENT\s+([^\n\r]+)/i)
                 ||text.match(/NOM\s+DU\s+PATIENT\s+([^\n\r]+)/i)
                 ||text.match(/PATIENT\s+NAME\s+([^\n\r]+)/i);
    if(nameLbl){
      r.name=nameLbl[1]
        .replace(/[*#@!?]+/g,'')               // strip *** *** etc
        .replace(/(?:ADDRESS|ADRESSE|CITY|VILLE|MEDICUM).*/i,'')
        .replace(/\s+/g,' ').trim();
    }
  }

  // ── 3. DOSE ────────────────────────────────────────────────
  // For DIGITAL PDFs: bold items from PDF.js font name detection
  // For SCANNED PDFs: look for dose before the options list
  // The form lists: 1-m (7.5mg)  3-m (22.5mg)  4-m (30mg)  6-m (45mg)
  // Selected one is bold + underlined — appears in boldItems array if digital
  // Selected dose is BOLD + UNDERLINED: "6-m (45mg)"
  // boldItems from PDF.js captures this
  const dmap=[
    {v:'45',  rx:[/45\s*mg/i, /6\s*-?\s*m\b/i]},
    {v:'30',  rx:[/30\s*mg/i, /4\s*-?\s*m\b/i]},
    {v:'22.5',rx:[/22[.,]5\s*mg/i,/3\s*-?\s*m\b/i]},
    {v:'7.5', rx:[/7[.,]5\s*mg/i, /1\s*-?\s*m\b/i]},
  ];
  // Check bold/styled items first (most reliable for digital PDFs)
  for(const item of bold){
    for(const{v,rx}of dmap){if(rx.some(r=>r.test(item))){r.dose=v;break;}}
    if(r.dose)break;
  }
  // OCR fallback: a mark read as text in front of exactly one option —
  // "[X] 3-m (22.5mg)", "☒ 6 mois", "X 4-m"
  if(!r.dose){
    const MO={'1':'7.5','3':'22.5','4':'30','6':'45'};
    const hits=new Set();
    const markRx=/(?:\[\s*[Xx✓✔]\s*\]|\|\s*[Xx]\s*\||[☒☑■✓✔]|(?:^|\s)[Xx](?=\s))\s*\(?\s*([1346])\s*-?\s*m(?:ois|onths?)?\b/g;
    let mm;while((mm=markRx.exec(text)))hits.add(MO[mm[1]]);
    if(hits.size===1)r.dose=[...hits][0];
  }
  // OCR fallback: look for dose appearing BEFORE the options list line
  if(!r.dose){
    const listIdx=text.search(/1\s*-?\s*m(?:ois)?\s*\(?\s*7[.,]5/i);
    if(listIdx>0){
      const before=text.slice(0,listIdx);
      for(const{v,rx}of dmap){if(rx.some(p=>p.test(before))){r.dose=v;break;}}
    }
  }

  // Number of injections ("Number of injections/Nombre d'injection a recevoir: 6")
  const injM=text.match(/Number\s+of\s+injections?\s*\/?\s*(?:Nombre\s+d['’]\s*injections?\s*(?:[aà]\s*recevoir)?)?\s*:?\s*[x×]?\s*(\d{1,2})\b(?!\s*[\/.-]\d)/i);
  if(injM) r.injections=injM[1];
  // Months after the chosen option in OCR text ("3-m (22.5mg) 18 4-m (30mg)")
  if(r.dose && !r.months){
    const mo=DOSE_MONTHS[r.dose], dv=r.dose.replace('.','[.,]');
    const mm=text.match(new RegExp(mo+'\\s*-?\\s*m(?:ois)?\\s*\\(?\\s*'+dv+'\\s*mg\\s*\\)?\\s*[x×:]?\\s*(\\d{1,2})\\b(?!\\s*-?\\s*m\\b|\\s*[.,]\\d|\\s*mg)','i'));
    if(mm) r.months=mm[1];
  }

  // ── 4. ADDRESS ─────────────────────────────────────────────
  // Table row: "ADDRESS/ADRESSE | 1 Boulevard De Maisonneuve Ouest Appartement 703"
  // OCR:       "ADDRESS/ADRESSE 1 Boulevard De Maisonneuve Ouest Appartement 703"
  // Street extraction — 3 strategies:
  // 1. Standard label: "ADDRESS/ADRESSE [street] CITY/VILLE"
  // 2. No label: "[Name] [File#], [street] CITY/VILLE" (your actual OCR format)
  // 3. "Page 1" summary at end of OCR text
  let addrRaw='';
  const addrLbl=text.match(/ADDRESS\s*\/\s*ADRESSE\s+(.+?)(?=\s+CITY\s*\/|\s+CITY\s+VILLE)/i)
               ||text.match(/ADRESSE\s+(.+?)(?=\s+CITY\s*\/|\s+CITY\s+VILLE)/i);
  if(addrLbl){
    addrRaw=addrLbl[1].replace(/\s+/g,' ').trim();
  } else {
    // Format: "Name FileNum, [street] CITY/VILLE"
    const noLbl=text.match(/\d{3,8}\s*,\s*(.+?)(?=\s+CITY\s*\/|\s+CITY\s+VILLE)/i);
    if(noLbl)addrRaw=noLbl[1].replace(/\s+/g,' ').trim();
  }
  if(addrRaw){
    // Apartment / unit → kept with its label, placed after the postal code
    const u=splitUnit(addrRaw);
    r.street=u.street; r.apt=u.unit;
  }
  // Apt fallback from "Page 1" summary: "Page 1, City, Prov, Postal, AptNum, Ph1, Ph2, Date"
  if(!r.apt){
    const pgM=text.match(/Page\s+\d\s*,\s*[^,]+,\s*[A-Z]{2}\s*,\s*[A-Z]\d[A-Z]\s*\d[A-Z]\d\s*,\s*(\d+)\s*,/i);
    if(pgM)r.apt='Apt. '+pgM[1];
  }

  // City/Province/Postal — "CITY/VILLE | Montreal, QC, H2X 0E3"
  const cityM=text.match(/CITY\s*[\/|]\s*VILLE\s+([^\n\r]+)/i)
             ||text.match(/VILLE\s+([^\n\r]{2,60})/i);
  if(cityM){
    const parts=cityM[1].split(',').map(s=>s.trim()).filter(Boolean);
    if(parts[0])r.city=parts[0];
    if(parts[1])r.prov=parts[1].toUpperCase();
    if(parts[2]){const pM=parts[2].match(/([A-Z]\d[A-Z]\s*\d[A-Z]\d)/i);if(pM)r.postal=pM[1].toUpperCase();}
  }
  // Postal fallback
  if(!r.postal){const pM=text.match(/\b([A-Z]\d[A-Z]\s*\d[A-Z]\d)\b/i);if(pM)r.postal=pM[1].toUpperCase();}

  // ── 5. PHONES ──────────────────────────────────────────────
  // Build exclusion set (doctor tel/fax + pharmacy)
  const excl=new Set();
  const drB=text.match(/DOCTOR.{0,5}NAME[\s\S]{0,300}?(?=PRESCRIPTION|DATE\s+OF\s+BIRTH|LAST\s+INJECTION|$)/i);
  if(drB)(drB[0].match(/\d{3}[\s\-]?\d{3}[\s\-]?\d{4}/g)||[]).forEach(p=>excl.add(fmtPh(p)));
  const phB=text.match(/PHARMACY\s*#[\s\S]{0,80}?(?=DOCTOR|DATE|LAST|$)/i);
  if(phB)(phB[0].match(/\d{3}[\s\-]?\d{3}[\s\-]?\d{4}/g)||[]).forEach(p=>excl.add(fmtPh(p)));

  // Phone 1: right after TELEPHONE label
  const t1=text.match(/TELEPHONE\s*[\/|]\s*TELEPHONE\s*(\d{3}[\s\-]?\d{3}[\s\-]?\d{4})/i)
          ||text.match(/TELEPHONE\s*:?\s*(\d{3}[\s\-]?\d{3}[\s\-]?\d{4})/i);
  if(t1){const p=fmtPh(t1[1]);if(!excl.has(p))r.ph1=p;}

  // Phone 2: SECONDARY CONTACT block — strip labels like "Cellulaire/ Tel:"
  const secRaw=text.match(/SECONDARY\s*CONTACT[\s\S]{0,300}?(?=DATE\s*OF\s*BIRTH|LAST\s*INJECTION|PHARMACY|DOCTOR|$)/i);
  if(secRaw){
    const secTxt=secRaw[0];
    // Skip if secondary contact says "no other contact" or similar
    if(!/no\s+other\s+contact|aucun\s+autre|sans\s+contact/i.test(secTxt)){
      const secPhs=(secTxt.match(/\d{3}[\s\-]?\d{3}[\s\-]?\d{4}/g)||[])
        .map(p=>fmtPh(p))
        .filter(p=>p&&p!==r.ph1&&!excl.has(p));
      if(secPhs.length)r.ph2=secPhs[secPhs.length-1];
    }
  }
  // Fallback: all phones in text minus excluded
  if(!r.ph1||!r.ph2){
    const allPh=[...text.matchAll(/\d{3}[\s\-]?\d{3}[\s\-]?\d{4}/g)]
      .map(m=>fmtPh(m[0])).filter((v,i,a)=>v&&a.indexOf(v)===i&&!excl.has(v));
    if(!r.ph1&&allPh[0])r.ph1=allPh[0];
    if(!r.ph2)r.ph2=allPh.find(p=>p!==r.ph1)||'';
  }

  // ── 6. DUE DATE ────────────────────────────────────────────
  // Check "INJECTION DUE DAY OF:" first
  const dueDayM=text.match(/INJECTION\s*DUE\s*DAY\s*OF[^:]*:\s*([^\n\r]{0,40})/i);
  if(dueDayM){
    const dM=dueDayM[1].match(/(\d{1,2}[\s\w]*\d{4}|\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4})/i);
    if(dM)r.date=fmtDate(dM[1]);
  }
  // "INJECTION WILL BE READY" — often has the actual ready date (e.g. "21 Avril 2026")
  if(!r.date){
    const readyM=text.match(/INJECTION\s*WILL\s*BE\s*READY[^0-9\n\r]*([^\n\r]{0,40})/i);
    if(readyM){
      // Match "21 Avril 2026" or "21 April 2026" or "MM/DD/YYYY"
      const dM=readyM[1].match(/(\d{1,2}\s+[A-Za-z\u00C0-\u00FF]+\s+\d{4}|\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4})/i);
      if(dM)r.date=fmtDate(dM[1]);
    }
  }
  // "NEXT INJECTION" fallback
  if(!r.date){
    const nxtM=text.match(/NEXT\s*INJECTION[^0-9\n\r]*(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4})/i);
    if(nxtM)r.date=fmtDate(nxtM[1]);
  }

  return r;
}



// Parse an extracted PDF. When the dose row was found on a text PDF, the
// position-based result is final (blank = nothing clearly marked); the text
// fallbacks inside parse() are only for OCR / forms without a dose row.
function parseMedicumPdf(ex, fname){
  const r=parse(ex.txt, ex.bold, fname);
  if(ex.dose && ex.dose.reason!=='dose options not found') r.dose=ex.dose.value;
  r.doseReason=ex.dose?ex.dose.reason:'';
  if(ex.months && r.dose===ex.dose.value) r.months=ex.months;
  const rp=repeatsFor(r.dose, r.injections, r.months);
  r.totalDoses=rp.total; r.totalWhy=rp.why;
  return r;
}

const api = { extractMedicumText, parseMedicum: parse, parseMedicumPdf, formatAddress, formatUnit, splitUnit, repeatsFor };
if (typeof module === 'object' && module.exports) module.exports = api;
else Object.assign(root, api);
})(typeof self !== 'undefined' ? self : this);
