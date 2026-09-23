// control-plane/src/phi_guard.js
// Responsibility: detect common patient-identifier patterns in free-text fields
// before they can be persisted or emailed. This is a mechanical guard, not a
// guarantee of de-identification — it catches the high-risk shapes the spec
// names (MRN, SSN, DOB, phone) and gives the UI a clear rejection message.
// Called by: routes/alerts.js (resolution_record close flow) and deliver.js
// (outbound email text/subject).

// Each pattern is intentionally conservative: it looks for values, not labels,
// so "patient MRN 1234567" and a bare "1234567" in a note are both caught.
// Ordering matters — more specific patterns (SSN, phone, DOB) are tested before
// the looser MRN digit pattern so a phone number isn't reported as an MRN.
const PHI_PATTERNS = [
  {
    type: 'ssn',
    re: /\b\d{3}-\d{2}-\d{4}\b|\b\d{9}\b/,
    ui: 'Possible Social Security number',
  },
  {
    type: 'phone',
    re: /\b(?:\+1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/,
    ui: 'Possible phone number',
  },
  {
    type: 'dob',
    re: /\b\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}\b/,
    ui: 'Possible date of birth',
  },
  {
    type: 'mrn',
    re: /\b\d{6,10}\b/,
    ui: 'Possible medical record number',
  },
];

// scanPhi — returns { ok, type, ui, matched } for a single string value.
// Empty/null values are fine; the guard only acts on actual text.
export function scanPhi(value) {
  if (value == null || value === '') return { ok: true, type: null, ui: null, matched: null };
  if (typeof value !== 'string') return { ok: true, type: null, ui: null, matched: null };
  for (const p of PHI_PATTERNS) {
    const m = value.match(p.re);
    if (m) {
      return { ok: false, type: p.type, ui: p.ui, matched: m[0] };
    }
  }
  return { ok: true, type: null, ui: null, matched: null };
}

// assertNoPhi — convenience for HTTP endpoints. Returns { ok, error } with the
// canonical UI warning text the spec requires.
export function assertNoPhi(value, fieldName) {
  const r = scanPhi(value);
  if (r.ok) return { ok: true };
  return {
    ok: false,
    error: `${r.ui} (${r.matched}) in ${fieldName}. No patient identifiers in ${fieldName}.`,
  };
}
