/**
 * Compares what the user typed (first name, last name, date of birth) with the NIMC record, and blends it with the
 * selfie face-match score into one 0–100 identity score.
 *
 * Weights: face 50, first name 12, last name 12, middle name 6, date of birth 14, gender 6. A field the user left blank,
 * or that NIMC didn't return, scores 0 (it can't help them, but it doesn't block the face match either). The middle name
 * is the exception: no middle name typed and none on the record is a match.
 */
export type TypedDetails = { firstName?: string; middleName?: string; lastName?: string; dateOfBirth?: string; gender?: string };
export type NimcDetails = { firstName?: string; middleName?: string; lastName?: string; dateOfBirth?: string; gender?: string };
export type IdentityScore = { score: number; face: number; firstName: number; middleName: number; lastName: number; dateOfBirth: number; gender: number };

const W = { face: 50, firstName: 12, lastName: 12, middleName: 6, dateOfBirth: 14, gender: 6 };
/** "M", "Male", "male " -> "m"; anything else -> "". */
const sex = (g?: string) => { const c = String(g ?? '').trim().toLowerCase()[0]; return c === 'm' || c === 'f' ? c : ''; };

const norm = (s?: string) => (s ?? '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z]/g, '');

function lev(a: string, b: string) {
  const d = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = d[0]; d[0] = i;
    for (let j = 1; j <= b.length; j++) { const t = d[j]; d[j] = Math.min(d[j] + 1, d[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1)); prev = t; }
  }
  return d[b.length];
}
/** 0–1 similarity; tolerates a typo or two ("Oluwaseun" vs "Oluwasegun") but not a different name. */
function similarity(a: string, b: string) {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const s = 1 - lev(a, b) / Math.max(a.length, b.length);
  return s >= 0.75 ? s : 0;
}
/** Best match of a typed name against any NIMC name (people often swap first/middle names). Exact field first. */
function nameScore(typed: string | undefined, own: string | undefined, others: (string | undefined)[]) {
  const t = norm(typed);
  if (!t) return 0;
  const exact = similarity(t, norm(own));
  const alt = Math.max(0, ...others.map((o) => similarity(t, norm(o)))) * 0.8; // right name, wrong box: partial credit
  return Math.max(exact, alt);
}

/** Normalise the common date shapes to YYYY-MM-DD: 1990-01-31, 31-01-1990, 31/01/1990, 31-Jan-1990, 1990-01-31T00:00:00Z. */
export function toIsoDate(v?: string): string | null {
  if (!v) return null;
  const s = String(v).trim();
  let m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/.exec(s);
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/.exec(s);
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`; // Nigerian order: day first
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : new Date(t).toISOString().slice(0, 10);
}

export function scoreIdentity(faceScore: number, typed: TypedDetails, nimc: NimcDetails): IdentityScore {
  const face = Math.max(0, Math.min(100, Number(faceScore) || 0)) / 100;
  const firstName = nameScore(typed.firstName, nimc.firstName, [nimc.middleName, nimc.lastName]);
  const lastName = nameScore(typed.lastName, nimc.lastName, [nimc.firstName, nimc.middleName]);
  const middleName = !norm(typed.middleName) && !norm(nimc.middleName) ? 1 : nameScore(typed.middleName, nimc.middleName, [nimc.firstName, nimc.lastName]);
  const gender = sex(typed.gender) && sex(typed.gender) === sex(nimc.gender) ? 1 : 0;
  const a = toIsoDate(typed.dateOfBirth); const b = toIsoDate(nimc.dateOfBirth);
  const dateOfBirth = a && b && a === b ? 1 : 0;
  const score = Math.round(face * W.face + firstName * W.firstName + lastName * W.lastName + middleName * W.middleName
    + dateOfBirth * W.dateOfBirth + gender * W.gender);
  const pct = (x: number) => Math.round(x * 100);
  return { score, face: pct(face), firstName: pct(firstName), middleName: pct(middleName), lastName: pct(lastName), dateOfBirth: pct(dateOfBirth), gender: pct(gender) };
}
