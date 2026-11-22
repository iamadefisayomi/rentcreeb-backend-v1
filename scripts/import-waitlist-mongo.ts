/**
 * One-off: copy the old website's MongoDB `waitlist` collection into Supabase as mailing contacts tagged "waitlist",
 * so it shows in Admin → Waitlist. Only needs migration 018 (not 023). Nothing in MongoDB is changed.
 *
 *   npx tsx scripts/import-waitlist-mongo.ts --dry   # read and report, write nothing
 *   npx tsx scripts/import-waitlist-mongo.ts         # import
 *
 * Safe to run again: people are matched by email. A contact that already exists gets the "waitlist" tag;
 * answers already stored in Supabase (e.g. a newer sign-up, or an admin's status/notes) win over the Mongo copy.
 * Mongo URI comes from ../rentcreeb_file/client/.env.local (or MONGODB_URI).
 */
import fs from 'fs';
import path from 'path';
import { MongoClient } from 'mongodb';
import { db } from '../src/lib/supabase';

const DRY = process.argv.includes('--dry');
const WEB_ENV = path.resolve(__dirname, '../../rentcreeb_file/client/.env.local');
const webEnv: Record<string, string> = (() => {
  try {
    return Object.fromEntries(fs.readFileSync(WEB_ENV, 'utf8').split(/\r?\n/).filter((l) => /^[A-Z_]+=/.test(l))
      .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim().replace(/^["']|["']$/g, '')]));
  } catch { return {}; }
})();
const MONGODB_URI = process.env.MONGODB_URI || webEnv.MONGODB_URI;

/** Old website statuses → the admin dashboard's (pending, contacted, invited, joined, declined). */
function mapStatus(s: unknown) {
  const v = String(s ?? '').trim().toLowerCase();
  if (!v || ['pending', 'new', 'waiting'].includes(v)) return 'pending';
  if (['contacted', 'reached', 'called', 'emailed'].includes(v)) return 'contacted';
  if (['invited', 'approved', 'accepted'].includes(v)) return 'invited';
  if (['joined', 'onboarded', 'converted', 'active', 'registered'].includes(v)) return 'joined';
  if (['declined', 'rejected', 'not_interested', 'not interested', 'removed'].includes(v)) return 'declined';
  return 'pending';
}
const iso = (d: unknown) => { const t = d ? new Date(d as any) : null; return t && !isNaN(+t) ? t.toISOString() : null; };
const str = (v: unknown, max = 2000) => (v == null ? '' : String(v).trim().slice(0, max));

async function main() {
  if (!MONGODB_URI) throw new Error('MONGODB_URI not found (set it, or keep it in rentcreeb_file/client/.env.local)');
  const { error: e018 } = await db.from('mailing_contacts').select('id').limit(1);
  if (e018) throw new Error('mailing_contacts is missing: apply supabase/migrations/018_support_chat_and_mailing.sql first');

  const client = new MongoClient(MONGODB_URI, { serverSelectionTimeoutMS: 20000 });
  await client.connect();
  const docs = await client.db().collection('waitlist').find({}).sort({ createdAt: 1 }).toArray();
  await client.close();

  const statuses: Record<string, number> = {};
  const keys = new Set<string>();
  const seen = new Set<string>();
  let created = 0, tagged = 0, already = 0, noEmail = 0, dupes = 0, failed = 0;

  for (const w of docs) {
    Object.keys(w).forEach((k) => keys.add(k));
    statuses[String(w.status ?? '(none)')] = (statuses[String(w.status ?? '(none)')] ?? 0) + 1;
    const email = str(w.email, 254).toLowerCase();
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { noEmail++; continue; }
    if (seen.has(email)) { dupes++; continue; }
    seen.add(email);

    const [first, ...rest] = str(w.name, 120).split(/\s+/);
    const attributes = {
      phone: str(w.phone, 30), state: str(w.state, 60), lga: str(w.lga, 80), city: str(w.city, 80),
      interest: Array.isArray(w.interest) ? w.interest.map((x: unknown) => str(x, 120)).filter(Boolean) : w.interest ? [str(w.interest, 120)] : [],
      iAm: str(w.iAm, 80), message: str(w.message), waitlistStatus: mapStatus(w.status), waitlistSource: str(w.source, 40) || 'website',
      notes: str(w.notes), ...(w.status && mapStatus(w.status) !== String(w.status).toLowerCase() ? { legacyStatus: str(w.status, 40) } : {}),
      legacyId: String(w._id),
    };
    const joinedAt = iso(w.createdAt) ?? new Date().toISOString();

    const { data: ex, error: e1 } = await db.from('mailing_contacts').select('id, tags, attributes').eq('email', email).maybeSingle();
    if (e1) { failed++; console.error(`  ${email}: ${e1.message}`); continue; }
    if (ex?.tags?.includes('waitlist')) { already++; continue; }
    if (DRY) { ex ? tagged++ : created++; continue; }

    const { error } = ex
      ? await db.from('mailing_contacts').update({ tags: [...new Set([...(ex.tags ?? []), 'waitlist'])], attributes: { ...attributes, ...(ex.attributes ?? {}) }, updated_at: new Date().toISOString() }).eq('id', ex.id)
      : await db.from('mailing_contacts').insert({
        email, first_name: first || null, last_name: rest.join(' ') || null, source: 'import', status: 'subscribed',
        consent_at: joinedAt, confirmed_at: joinedAt, tags: ['waitlist'], attributes, created_at: joinedAt, updated_at: iso(w.updatedAt) ?? joinedAt,
      });
    if (error) { failed++; console.error(`  ${email}: ${error.message}`); continue; }
    ex ? tagged++ : created++;
  }

  console.log(DRY ? '\n— DRY RUN: nothing was written —' : '\n— Waitlist imported —');
  console.log(`  in MongoDB:                         ${docs.length}`);
  console.log(`  ${DRY ? 'would be added' : 'added'} as new contacts:        ${created}`);
  console.log(`  ${DRY ? 'would be tagged' : 'tagged'} (already a contact):    ${tagged}`);
  console.log(`  already on the Supabase waitlist:   ${already}`);
  console.log(`  skipped (no/invalid email):         ${noEmail}`);
  console.log(`  skipped (duplicate email in Mongo): ${dupes}`);
  if (failed) console.log(`  FAILED:                             ${failed}`);
  console.log(`  old statuses: ${JSON.stringify(statuses)}`);
  console.log(`  fields seen:  ${[...keys].join(', ')}`);
}

main().then(() => process.exit(0)).catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
