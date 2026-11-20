/**
 * One-off move of the old rentcreeb.com website data (MongoDB + ImageKit + GridFS) into the shared backend
 * (Supabase + Bunny), so the website and the app use one database and one file store.
 *
 *   npx tsx scripts/migrate-website-mongo.ts --dry      # read everything, change nothing, print the plan
 *   npx tsx scripts/migrate-website-mongo.ts            # do it (needs migrations 018 and 023 applied)
 *
 * Safe to run again: everything it creates carries the old Mongo id (legacy_id) and is skipped next time.
 * Mongo URI is read from ../rentcreeb_file/client/.env.local (or MONGODB_URI). Nothing in MongoDB is changed.
 *
 * What moves: website accounts (matched to existing RentCreeb accounts by email; old passwords keep working),
 * profile photos, listings with all their photos (re-uploaded to Bunny), favourites, reviews, chats and messages,
 * social links and the waitlist. What does not: old inspection payments (made outside the backend's escrow),
 * NIN verifications (people verify again with the app's check), sessions.
 */
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { createHash, randomBytes } from 'crypto';
/** Stable uuid for an old Mongo id (chat context of a listing that no longer exists). */
const legacyUuid = (id: string) => { const h = createHash('md5').update('rentcreeb-legacy:' + id).digest('hex'); return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`; };
import { db } from '../src/lib/supabase';
import { uploadToBunny } from '../src/lib/bunny';
import { env } from '../src/config/env';
import { fromWebProperty } from '../../rentcreeb_file/client/lib/adapters';

const DRY = process.argv.includes('--dry');
const WEB_DIR = path.resolve(__dirname, '../../rentcreeb_file/client');
const requireWeb = createRequire(path.join(WEB_DIR, 'package.json'));
const { MongoClient, GridFSBucket, ObjectId } = requireWeb('mongodb');

const webEnv = (() => {
  try {
    return Object.fromEntries(fs.readFileSync(path.join(WEB_DIR, '.env.local'), 'utf8').split(/\r?\n/).filter((l) => /^[A-Z_]+=/.test(l))
      .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim().replace(/^["']|["']$/g, '')]));
  } catch { return {} as Record<string, string>; }
})();
const MONGODB_URI = process.env.MONGODB_URI || webEnv.MONGODB_URI;

const report: Record<string, number> = {};
const notes: string[] = [];
const bump = (k: string, n = 1) => { report[k] = (report[k] ?? 0) + n; };
const sid = (v: any) => (v == null ? null : String(v));
const sanitizeUsername = (u?: string | null) => (u ? u.toLowerCase().replace(/[^a-z0-9._-]/g, '').slice(0, 30) : null);
const normalizePhone = (p?: string | null) => {
  if (!p) return null;
  let d = String(p).replace(/[^\d+]/g, '');
  if (d.startsWith('0') && d.length === 11) d = '+234' + d.slice(1);
  if (/^234\d{10}$/.test(d)) d = '+' + d;
  return /^\+234[789][01]\d{8}$/.test(d) ? d : null;
};

async function main() {
  if (!MONGODB_URI) throw new Error('MONGODB_URI not found (set it, or keep it in rentcreeb_file/client/.env.local)');
  console.log(DRY ? '— DRY RUN: nothing will be written —' : '— MIGRATING —');

  // Schema check: migration 023 (legacy ids, website fields) and 018 (mailing contacts for the waitlist).
  const has023 = !(await db.from('properties').select('legacy_id, slug, web_details, listed_in').limit(1)).error
    && !(await db.from('legacy_credentials').select('user_id').limit(1)).error;
  const has018 = !(await db.from('mailing_contacts').select('id').limit(1)).error;
  if (!has023 && !DRY) throw new Error('Apply supabase/migrations/023_website.sql first (and 018 for the waitlist).');
  if (!has023) notes.push('Migration 023 is not applied yet: the real run will refuse to start until it is.');
  if (!has018) notes.push('Migration 018 is not applied: the waitlist will be skipped.');

  const client = new MongoClient(MONGODB_URI, { serverSelectionTimeoutMS: 20000 });
  await client.connect();
  const mdb = client.db();
  const bucket = new GridFSBucket(mdb, { bucketName: 'images' });

  // ── Files: ImageKit / GridFS / old /api/image/<id> links → Bunny ──
  const moved = new Map<string, string>();
  async function download(url: string): Promise<{ buf: Buffer; type: string; name: string } | null> {
    const grid = /\/api\/image\/([a-f0-9]{24})/.exec(url)?.[1] ?? (/^[a-f0-9]{24}$/.test(url) ? url : null);
    if (grid) {
      const file = await mdb.collection('images.files').findOne({ _id: new ObjectId(grid) });
      if (!file) return null;
      const chunks: Buffer[] = [];
      await new Promise<void>((res, rej) => bucket.openDownloadStream(file._id).on('data', (c: Buffer) => chunks.push(c)).on('end', () => res()).on('error', rej));
      return { buf: Buffer.concat(chunks), type: file.contentType ?? 'image/webp', name: file.filename ?? `${grid}.webp` };
    }
    if (!/^https?:\/\//.test(url)) return null;
    const r = await fetch(url, { signal: AbortSignal.timeout(60_000) }).catch(() => null);
    if (!r?.ok) return null;
    const type = (r.headers.get('content-type') ?? 'image/webp').split(';')[0];
    if (!/^(image|video)\//.test(type)) return null;
    return { buf: Buffer.from(await r.arrayBuffer()), type, name: url.split('?')[0].split('/').pop() || 'image.webp' };
  }
  /** Copy a website file to Bunny. Google/Unsplash and other outside links are kept as they are. */
  async function moveFile(url: string | null | undefined, folder: string): Promise<string | null> {
    if (!url) return null;
    if (url.startsWith(env.BUNNY_CDN_URL)) return url;
    const ours = /ik\.imagekit\.io|\/api\/image\/|^[a-f0-9]{24}$/.test(url);
    if (!ours) return url;
    if (moved.has(url)) return moved.get(url)!;
    const f = await download(url);
    if (!f) { bump('files: could not download'); notes.push(`Could not download ${url}`); return null; }
    bump('files copied to Bunny');
    bump('bytes copied', f.buf.length);
    if (DRY) { moved.set(url, `${env.BUNNY_CDN_URL}/${folder}/(new)-${f.name}`); return moved.get(url)!; }
    const { url: out } = await uploadToBunny(f.buf, folder, f.name, false, f.type);
    moved.set(url, out!);
    return out!;
  }

  // ── 1. Accounts ──
  const userMap = new Map<string, string>(); // mongo user id → profile id
  const users = await mdb.collection('user').find({}).toArray();
  const accounts = await mdb.collection('account').find({}).toArray();
  const usernamesTaken = new Set(((await db.from('profiles').select('username').not('username', 'is', null)).data ?? []).map((p: any) => String(p.username).toLowerCase()));
  for (const u of users) {
    const mid = sid(u._id)!;
    const email = String(u.email ?? '').trim().toLowerCase();
    if (!email) { bump('accounts: skipped (no email)'); continue; }
    let profile: any = null;
    if (has023) profile = (await db.from('profiles').select('*').eq('legacy_id', mid).maybeSingle()).data;
    if (!profile) profile = (await db.from('profiles').select('*').ilike('email', email.replace(/[\\%_]/g, (c) => '\\' + c)).maybeSingle()).data;
    const [first, ...rest] = String(u.name ?? '').trim().split(/\s+/);
    const role = u.accountType === 'agent' || u.role === 'agent' ? 'agent' : 'tenant';
    if (u.role === 'admin') notes.push(`Website admin ${email.replace(/^(.).*@/, '$1***@')} was NOT made a backend admin automatically; promote them in the admin dashboard if wanted.`);
    const cred = accounts.find((a: any) => sid(a.userId) === mid && a.providerId === 'credential' && a.password);
    const providers = accounts.filter((a: any) => sid(a.userId) === mid).map((a: any) => a.providerId);

    if (profile) {
      bump('accounts: matched existing RentCreeb account');
      userMap.set(mid, profile.id);
      if (DRY) continue;
      const patch: Record<string, unknown> = { legacy_id: mid };
      if (!profile.whatsapp && u.whatsapp) patch.whatsapp = u.whatsapp;
      if (!profile.username) { const un = sanitizeUsername(u.username); if (un && !usernamesTaken.has(un)) { patch.username = un; usernamesTaken.add(un); } }
      if (!profile.avatar_url && u.image) patch.avatar_url = await moveFile(u.image, `avatars/${profile.id}`);
      if (!profile.gender && ['male', 'female', 'other'].includes(String(u.gender).toLowerCase())) patch.gender = String(u.gender).toLowerCase();
      await db.from('profiles').update(patch).eq('id', profile.id);
      // Their existing RentCreeb password stays; the old website password is only kept if they had none.
      continue;
    }

    bump('accounts: created');
    if (cred) bump('accounts: old password kept');
    if (providers.includes('google')) bump('accounts: Google sign-in (links on first Google sign-in)');
    if (DRY) { userMap.set(mid, `new:${mid}`); continue; }
    const { data: created, error } = await db.auth.admin.createUser({
      email, email_confirm: u.emailVerified !== false,
      password: randomBytes(24).toString('base64url') + 'Aa1!', // unusable; the old website password (or Google) is used to sign in
      user_metadata: { first_name: first || null, last_name: rest.join(' ') || null, role, signup_source: 'website' },
    });
    if (error || !created.user) { bump('accounts: failed'); notes.push(`Account ${email.replace(/^(.).*@/, '$1***@')}: ${error?.message}`); continue; }
    const id = created.user.id;
    userMap.set(mid, id);
    const un = sanitizeUsername(u.username);
    const phone = normalizePhone(u.phone);
    const phoneFree = phone ? !(await db.from('profiles').select('id').eq('phone', phone).maybeSingle()).data : false;
    await db.from('profiles').update({
      legacy_id: mid,
      username: un && !usernamesTaken.has(un) ? un : null,
      whatsapp: u.whatsapp || null,
      phone: phoneFree ? phone : null, phone_verified: false,
      gender: ['male', 'female', 'other'].includes(String(u.gender).toLowerCase()) ? String(u.gender).toLowerCase() : null,
      avatar_url: await moveFile(u.image, `avatars/${id}`),
      onboarding_completed: true,
      created_at: u.createdAt ?? undefined,
    }).eq('id', id);
    if (un) usernamesTaken.add(un);
    if (cred) await db.from('legacy_credentials').upsert({ user_id: id, hash: cred.password });
  }

  // Social links (two collections were used over time).
  for (const col of ['socials', 'usersocials']) {
    for (const s of await mdb.collection(col).find({}).toArray()) {
      const pid = userMap.get(sid(s.userId)!);
      if (!pid) continue;
      bump('social links');
      if (DRY || pid.startsWith('new:')) continue;
      const socials = Object.fromEntries(['facebook', 'instagram', 'twitter', 'linkedin', 'tiktok', 'youtube', 'website'].filter((k) => s[k]).map((k) => [k, String(s[k])]));
      if (Object.keys(socials).length) await db.from('profiles').update({ socials }).eq('id', pid);
    }
  }
  for (const pd of await mdb.collection('professionaldetails').find({}).toArray()) {
    const pid = userMap.get(sid(pd.userId)!);
    if (!pid) continue;
    bump('professional details');
    if (DRY || pid.startsWith('new:')) continue;
    const { _id, userId, __v, createdAt, updatedAt, ...rest } = pd;
    await db.from('profiles').update({ professional: rest }).eq('id', pid);
  }

  // ── 2. Listings + photos ──
  const propMap = new Map<string, string>();
  const ownerOf = new Map<string, string>();
  for (const p of await mdb.collection('properties').find({}).toArray()) {
    const mid = sid(p._id)!;
    const owner = userMap.get(sid(p.userId)!);
    if (!owner) { bump('listings: skipped (owner not found)'); continue; }
    if (has023) {
      const { data: ex } = await db.from('properties').select('id, owner_id').eq('legacy_id', mid).maybeSingle();
      if (ex) { propMap.set(mid, ex.id); ownerOf.set(ex.id, ex.owner_id); bump('listings: already moved'); continue; }
    }
    const photos = [...(p.images ?? [])];
    bump('listings: moved');
    bump('listing photos', photos.length);
    if (DRY) {
      for (const url of [...photos, ...(p.floorPlan ?? [])]) await moveFile(url, `properties/${owner}`);
      propMap.set(mid, `new:${mid}`); continue;
    }
    const urls = (await Promise.all(photos.map((u: string) => moveFile(u, `properties/${owner}`)))).filter(Boolean) as string[];
    const floorPlan = (await Promise.all((p.floorPlan ?? []).map((u: string) => moveFile(u, `properties/${owner}`)))).filter(Boolean);
    const b: any = fromWebProperty({ ...p, floorPlan }, urls);
    const live = !p.isDeleted && p.published !== false && p.isAvailable !== false;
    const row: Record<string, unknown> = {
      owner_id: owner, title: b.title, description: b.description, address: b.address || '—', area: b.area, city: b.city, state: b.state,
      lat: b.lat, lng: b.lng, price_kobo: b.priceKobo ?? 0, price_period: b.pricePeriod, property_type: b.propertyType ?? 'apartment',
      bedrooms: b.bedrooms ?? 0, bathrooms: b.bathrooms ?? 0, size_sqm: b.sizeSqm, parking: !!b.parking, parking_spaces: b.parkingSpaces,
      amenities: b.amenities ?? [], security_features: b.securityFeatures, year_built: b.yearBuilt,
      video_urls: p.videoLink ? [p.videoLink] : undefined,
      // Listings that were live on the website stay live (they were already public there).
      status: p.isDeleted ? 'archived' : live ? 'approved' : 'unlisted', is_verified: !!p.isVerified,
      slug: p.slug || null, listed_in: b.listedIn, web_details: { ...b.webDetails, views: p.views ?? 0, favorites: p.favorites ?? 0, isFeatured: !!p.isFeatured },
      legacy_id: mid, unit_mode: 'single', created_at: p.createdAt ?? undefined, updated_at: p.updatedAt ?? undefined,
    };
    let ins = await db.from('properties').insert(row).select('id').single();
    if (ins.error && /video_urls/.test(ins.error.message)) { delete row.video_urls; ins = await db.from('properties').insert(row).select('id').single(); }
    if (ins.error && /slug/.test(ins.error.message)) { row.slug = `${p.slug}-${mid.slice(-4)}`; ins = await db.from('properties').insert(row).select('id').single(); }
    if (ins.error) { bump('listings: failed'); notes.push(`Listing "${p.title}": ${ins.error.message}`); continue; }
    const id = ins.data.id;
    propMap.set(mid, id); ownerOf.set(id, owner);
    if (urls.length) await db.from('property_media').insert(urls.map((url, i) => ({ property_id: id, url, media_type: 'image', position: i })));
    const beds = Number(p.bedrooms ?? 0);
    await db.from('units').insert({ property_id: id, label: 'Main', unit_type: (['studio', '1_bed', '2_bed', '3_bed'][beds] ?? '4_bed'), rent_kobo: b.pricePeriod === 'year' ? Math.round((b.priceKobo ?? 0) / 12) : b.pricePeriod === 'month' ? b.priceKobo ?? 0 : 0, bathrooms: Math.max(1, Number(p.bathrooms ?? 1)) });
  }

  // ── 3. Favourites → Saved ──
  for (const f of await mdb.collection('favourites').find({}).toArray()) {
    const uid = userMap.get(sid(f.userId)!);
    if (!uid) continue;
    for (const pidRaw of f.propertiesId ?? []) {
      const pid = propMap.get(sid(pidRaw)!);
      if (!pid) { bump('favourites: listing gone'); continue; }
      bump('favourites');
      if (DRY) continue;
      await db.from('saved_properties').upsert({ user_id: uid, property_id: pid }, { onConflict: 'user_id,property_id', ignoreDuplicates: true });
    }
  }

  // ── 4. Reviews ──
  for (const r of await mdb.collection('reviews').find({}).toArray()) {
    const pid = propMap.get(sid(r.propertyId)!);
    const uid = userMap.get(sid(r.userId)!);
    if (!pid || !uid) { bump('reviews: skipped (listing or reviewer gone)'); continue; }
    bump('reviews');
    if (DRY) continue;
    const { data: ex } = await db.from('reviews').select('id').eq('legacy_id', sid(r._id)).maybeSingle();
    if (ex) continue;
    const { error } = await db.from('reviews').insert({ property_id: pid, agent_id: ownerOf.get(pid), reviewer_id: uid, rating: Math.min(5, Math.max(1, Math.round(r.rating ?? 5))), comment: r.message ?? null, hidden: r.isApproved === false, legacy_id: sid(r._id), created_at: r.createdAt ?? undefined });
    if (error) notes.push(`Review: ${error.message}`);
  }

  // ── 5. Chats → enquiry conversations ──
  for (const c of await mdb.collection('chat').find({}).toArray()) {
    // A chat about a listing that was deleted later keeps its messages; it just has no listing card.
    const pid = propMap.get(sid(c.propertyId)!) ?? legacyUuid(sid(c.propertyId) ?? sid(c._id)!);
    if (!propMap.has(sid(c.propertyId)!)) bump('chats: listing no longer exists (messages kept)');
    const [a, b] = (c.participants ?? []).map((x: any) => userMap.get(sid(x)!));
    if (!a || !b || a === b) { bump('chats: skipped (person gone)'); continue; }
    const msgs = await mdb.collection('message').find({ chatId: c._id }).sort({ createdAt: 1 }).toArray();
    bump('chats'); bump('chat messages', msgs.length);
    if (DRY) continue;
    let conv = (await db.from('conversations').select('id').eq('legacy_id', sid(c._id)).maybeSingle()).data;
    if (!conv) {
      const ins = await db.from('conversations').insert({ context_type: 'property', context_id: pid, participant_a: a, participant_b: b, legacy_id: sid(c._id), created_at: c.createdAt ?? undefined }).select('id').single();
      if (ins.error) { notes.push(`Chat: ${ins.error.message}`); continue; }
      conv = ins.data;
    }
    const done = new Set(((await db.from('messages').select('legacy_id').eq('conversation_id', conv!.id)).data ?? []).map((m: any) => m.legacy_id));
    const rows = [];
    for (const m of msgs) {
      if (done.has(sid(m._id))) continue;
      const sender = userMap.get(sid(m.sender)!);
      if (!sender) continue;
      const receiver = sender === a ? b : a;
      const seen = (m.seenBy ?? []).find((s: any) => userMap.get(sid(s.userId)!) === receiver);
      const isImage = m.messageType === 'image' && /^https?:\/\//.test(m.content ?? '');
      rows.push({
        conversation_id: conv!.id, sender_id: sender, legacy_id: sid(m._id), created_at: m.createdAt ?? undefined,
        body: isImage ? null : m.content ?? '', attachment_url: isImage ? await moveFile(m.content, `chat/${sender}`) : null,
        read_at: seen?.seenAt ?? (m.status === 'seen' ? m.updatedAt : null),
      });
    }
    for (let i = 0; i < rows.length; i += 200) { const { error } = await db.from('messages').insert(rows.slice(i, i + 200)); if (error) notes.push(`Messages: ${error.message}`); }
  }

  // ── 6. Waitlist → mailing contacts tagged "waitlist" ──
  if (has018) {
    for (const w of await mdb.collection('waitlist').find({}).toArray()) {
      const email = String(w.email ?? '').trim().toLowerCase();
      if (!email) continue;
      bump('waitlist');
      if (DRY) continue;
      const [first, ...rest] = String(w.name ?? '').trim().split(/\s+/);
      const attributes = { phone: w.phone ?? '', state: w.state ?? '', lga: w.lga ?? '', city: w.city ?? '', interest: w.interest ?? [], iAm: w.iAm ?? '', message: w.message ?? '', waitlistStatus: w.status ?? 'pending', waitlistSource: w.source ?? 'website', notes: w.notes ?? '' };
      const { data: ex } = await db.from('mailing_contacts').select('id, tags, attributes').eq('email', email).maybeSingle();
      if (ex) await db.from('mailing_contacts').update({ tags: [...new Set([...(ex.tags ?? []), 'waitlist'])], attributes: { ...attributes, ...(ex.attributes ?? {}) } }).eq('id', ex.id);
      else await db.from('mailing_contacts').insert({ email, first_name: first || null, last_name: rest.join(' ') || null, source: 'import', status: 'subscribed', consent_at: w.createdAt ?? new Date().toISOString(), tags: ['waitlist'], attributes, created_at: w.createdAt ?? undefined });
    }
  }

  const skipped = { inspections: await mdb.collection('inspections').countDocuments(), 'NIN verifications': await mdb.collection('verifications').countDocuments() };
  await client.close();
  console.log('\nResult:'); for (const [k, v] of Object.entries(report)) console.log(`  ${k.padEnd(52)} ${k === 'bytes copied' ? (v / 1048576).toFixed(1) + ' MB' : v}`);
  console.log(`  not moved: ${skipped.inspections} old inspection payments, ${skipped['NIN verifications']} NIN verification records (people verify again)`);
  if (notes.length) { console.log('\nNotes:'); for (const n of [...new Set(notes)]) console.log('  - ' + n); }
}

main().then(() => process.exit(0)).catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
