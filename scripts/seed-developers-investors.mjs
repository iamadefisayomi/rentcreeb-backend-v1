// Sample developers, investors and development projects (needs migration 028).
//
//   node scripts/seed-developers-investors.mjs           create the sample accounts + data (safe to re-run)
//   node scripts/seed-developers-investors.mjs --dry     show what would be written
//   node scripts/seed-developers-investors.mjs --clean   remove the data AND the sample accounts this script created
//
// Accounts follow the demo pattern (developer@rentcreeb.test, investor@rentcreeb.test, …) with confirmed emails and the
// shared demo password RentcreebDemo123! (override with SEED_PASSWORD). Rows get deterministic ids, so re-running updates them.
// Existing users are only touched where noted (a couple of tenants and the agent from seed-sample-data.mjs get a
// watchlist entry / enquiry, if they exist).
import 'dotenv/config';
import { createHash } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';

const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const CLEAN = process.argv.includes('--clean');
const DRY = process.argv.includes('--dry');
const PASSWORD = process.env.SEED_PASSWORD || 'RentcreebDemo123!'; // same as the other demo accounts (tenant@rentcreeb.test …)

const sid = (key) => {
  const h = createHash('sha1').update('rentcreeb-seed-dev:' + key).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
};
const NOW = Date.now();
const at = (days, hour = 10) => { const d = new Date(NOW + days * 864e5); d.setUTCHours(hour, 0, 0, 0); return new Date(Math.min(d.getTime(), NOW - 60000)).toISOString(); };
const day = (days) => new Date(NOW + days * 864e5).toISOString().slice(0, 10);
const N = (naira) => Math.round(naira * 100);
const img = (id) => `https://images.unsplash.com/photo-${id}?w=1200&q=80`;
const must = async (p, what) => { const { error, data } = await p; if (error) throw new Error(`${what}: ${error.message}`); return data; };

// ───────── accounts ─────────
const ACCOUNTS = {
  landmark: { email: 'developer@rentcreeb.test', first: 'Tobi', last: 'Adeyemi', role: 'developer', phone: '+2348010000009', agency: 'Landmark Homes Ltd.', rc: 'RC 1482736', bio: 'Lagos developer of smart terraces and serviced apartments since 2012. 14 completed estates, 1,200+ homes delivered.' },
  greenfield: { email: 'developer2@rentcreeb.test', first: 'Halima', last: 'Bello', role: 'developer', phone: '+2348010000010', agency: 'Greenfield Developments', rc: 'RC 987114', bio: 'Abuja-based developer focused on gated family estates and verified land in fast-growing corridors.' },
  ngozi: { email: 'investor@rentcreeb.test', first: 'Ngozi', last: 'Eze', role: 'investor', phone: '+2348010000011', prefs: { cities: ['Lagos', 'Abuja'], budgetMaxKobo: N(150_000_000), goal: 'rental_income' }, bio: 'Diaspora investor (UK) building a rental portfolio in Lagos and Abuja.' },
  kunle: { email: 'investor2@rentcreeb.test', first: 'Kunle', last: 'Bakare', role: 'investor', phone: '+2348010000012', prefs: { cities: ['Lagos'], budgetMaxKobo: N(40_000_000), goal: 'land_banking' }, bio: 'First-time investor looking at land and off-plan in Lagos.' },
  amaka: { email: 'investor3@rentcreeb.test', first: 'Amaka', last: 'Okafor', role: 'investor', phone: '+2348010000013', prefs: { cities: ['Abuja'], budgetMaxKobo: N(90_000_000), goal: 'own_home' }, bio: 'Looking for a family home in Abuja, open to off-plan with a payment plan.' },
};
// Existing demo accounts that get a cross-role enquiry / watchlist entry (only if they exist).
const EXISTING_EMAILS = { tunde: 'tenant@rentcreeb.test', amara: 'tenant2@rentcreeb.test', chinedu: 'agent@rentcreeb.test' };
const EXISTING = {};

async function findUser(email) {
  for (let page = 1; page < 50; page++) {
    const { data, error } = await db.auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw new Error('listUsers: ' + error.message);
    const u = data.users.find((x) => x.email?.toLowerCase() === email.toLowerCase());
    if (u) return u;
    if (data.users.length < 200) return null;
  }
  return null;
}

async function ensureAccounts() {
  const U = {};
  for (const [key, a] of Object.entries(ACCOUNTS)) {
    let u = await findUser(a.email);
    if (!u) {
      const { data, error } = await db.auth.admin.createUser({ email: a.email, password: PASSWORD, email_confirm: true, user_metadata: { first_name: a.first, last_name: a.last, role: a.role, phone: a.phone } });
      if (error) throw new Error(`createUser ${a.email}: ${error.message}`);
      u = data.user; console.log(`created  ${a.role.padEnd(9)} ${a.email}`);
    } else console.log(`exists   ${a.role.padEnd(9)} ${a.email}`);
    U[key] = u.id;
    // The trigger makes the profile; fill in the rest (role set again in case it fell back to tenant before 028).
    await must(db.from('profiles').upsert({ id: u.id, email: a.email, first_name: a.first, last_name: a.last, role: a.role, phone: a.phone, bio: a.bio, phone_verified: true, nin_verified: true, onboarding_completed: true,
      agency_name: a.agency ?? null, license_number: a.rc ?? null, investment_prefs: a.prefs ?? null }, { onConflict: 'id' }), `profile ${a.email}`);
    await must(db.from('wallets').upsert({ user_id: u.id }, { onConflict: 'user_id', ignoreDuplicates: true }), 'wallet');
  }
  return U;
}

// ───────── data ─────────
function build(U, existing) {
  const rows = { dev_projects: [], dev_unit_types: [], dev_project_updates: [], conversations: [], messages: [], dev_leads: [], dev_watchlist: [], notifications: [] };
  const P = {}; const UT = {};
  const project = (key, dev, p, units) => {
    P[key] = { id: sid('proj:' + key), developer_id: dev, published: true, amenities: [], images: [], created_at: at(p.createdDays ?? -60), updated_at: at(-2), ...p };
    delete P[key].createdDays;
    rows.dev_projects.push(P[key]);
    units.forEach((u, i) => { UT[`${key}:${i}`] = { id: sid(`unit:${key}:${i}`), project_id: P[key].id, position: i, ...u }; rows.dev_unit_types.push(UT[`${key}:${i}`]); });
  };
  const update = (key, i, days, title, body, pct, images = []) => rows.dev_project_updates.push({ id: sid(`upd:${key}:${i}`), project_id: P[key].id, title, body, progress_pct: pct, images, created_at: at(days, 11) });

  project('palmgrove', U.landmark, {
    name: 'Palm Grove Residences', tagline: 'Smart 3 & 4-bed terraces minutes from the Lekki Free Trade Zone', kind: 'residential', status: 'under_construction', city: 'Lagos', area: 'Ibeju-Lekki', address: 'Off Lekki-Epe Expressway, Awoyaya',
    description: 'A gated community of 120 smart terraces with solar-backed power, treated water and fibre internet. Ten minutes from the Dangote Refinery corridor and the new Lekki Deep Sea Port, an area where land values have doubled since 2021.\n\nEvery home comes with smart locks, inverter wiring, a private garden and two parking spaces. Phase 1 handover is planned for Q3 2027.',
    progress_pct: 45, launch_date: day(-300), completion_date: day(280), title_document: "Governor's Consent", payment_plan: '30% initial deposit, balance over 18 months interest-free. 5% discount for outright payment. Allocation letter issued on 50% payment.',
    min_investment_kobo: N(15_000_000), expected_roi_pct: 40, rental_yield_pct: 8.5, amenities: ['24/7 Security', 'Power supply', 'Water treatment', 'Gated estate', 'Paved roads', 'Fibre internet', 'Children’s play area', 'CCTV'],
    images: [img('1570129477492-45c003edd2be'), img('1564013799919-ab600027ffc6'), img('1580587771525-78b9dba3b914'), img('1512917774080-9991f1c4c750')], createdDays: -300,
  }, [
    { name: '3 Bedroom Terrace', bedrooms: 3, size_sqm: 180, price_kobo: N(55_000_000), total_units: 60, available_units: 31 },
    { name: '4 Bedroom Terrace + BQ', bedrooms: 4, size_sqm: 240, price_kobo: N(78_000_000), total_units: 48, available_units: 22 },
    { name: '5 Bedroom Semi-detached', bedrooms: 5, size_sqm: 320, price_kobo: N(120_000_000), total_units: 12, available_units: 5 },
  ]);
  project('cityscape', U.landmark, {
    name: 'Cityscape Towers', tagline: 'Serviced apartments on Victoria Island with a rental-management programme', kind: 'mixed_use', status: 'under_construction', city: 'Lagos', area: 'Victoria Island', address: 'Ahmadu Bello Way',
    description: 'A 22-floor tower of serviced studios and 1–2 bed apartments above retail space. Buyers can join our rental-management programme: we furnish, let and manage the unit and pay out quarterly.',
    progress_pct: 68, launch_date: day(-520), completion_date: day(150), title_document: 'C of O', payment_plan: '40% deposit, 60% spread over 12 months. Rental programme optional (20% management fee).',
    min_investment_kobo: N(25_000_000), expected_roi_pct: 32, rental_yield_pct: 11, amenities: ['24/7 Security', 'Power supply', 'Gym', 'Swimming pool', 'Parking', 'CCTV', 'Fibre internet', 'Shopping mall'],
    images: [img('1545324418-cc1a3fa10c00'), img('1502672260266-1c1ef2d93688'), img('1522708323590-d24dbb6b0267'), img('1560448204-e02f11c3d0e2')], createdDays: -520,
  }, [
    { name: 'Serviced Studio', bedrooms: 0, size_sqm: 42, price_kobo: N(68_000_000), total_units: 80, available_units: 26 },
    { name: '1 Bedroom Apartment', bedrooms: 1, size_sqm: 70, price_kobo: N(110_000_000), total_units: 60, available_units: 19 },
    { name: '2 Bedroom Apartment', bedrooms: 2, size_sqm: 115, price_kobo: N(165_000_000), total_units: 40, available_units: 9 },
  ]);
  project('epeplots', U.landmark, {
    name: 'Lagoon View Plots', tagline: 'Dry, surveyed residential plots in Epe with instant allocation', kind: 'land', status: 'off_plan', city: 'Lagos', area: 'Epe', address: 'Epe-Ijebu-Ode Road',
    description: 'Fully dry, surveyed plots in a planned estate close to the proposed Lagos-Calabar coastal highway and the Alaro City industrial hub. Infrastructure (roads, drainage, perimeter fence) starts this year.',
    progress_pct: 10, launch_date: day(-60), completion_date: day(540), title_document: 'Registered Survey', payment_plan: '₦2M deposit, balance over 12 months. Physical allocation after full payment.',
    min_investment_kobo: N(2_000_000), expected_roi_pct: 60, amenities: ['Gated estate', 'Paved roads', 'Drainage'],
    images: [img('1500382017468-9049fed747ef'), img('1500076656116-558758c991c1')], createdDays: -60,
  }, [
    { name: '300 m² plot', size_sqm: 300, price_kobo: N(6_500_000), total_units: 150, available_units: 118 },
    { name: '600 m² plot', size_sqm: 600, price_kobo: N(12_000_000), total_units: 80, available_units: 61 },
  ]);
  project('katampe', U.greenfield, {
    name: 'Katampe Hills Terraces', tagline: 'Completed family terraces with views over Abuja', kind: 'residential', status: 'completed', city: 'Abuja', area: 'Katampe Extension', address: 'Katampe Hills',
    description: 'A finished estate of 40 terraces with central power, a clubhouse and 24-hour security. Ready to move in or let: comparable homes nearby rent for ₦8–10M a year.',
    progress_pct: 100, launch_date: day(-900), completion_date: day(-60), title_document: 'C of O', payment_plan: '50% deposit, balance within 6 months. Keys on full payment.',
    expected_roi_pct: 18, rental_yield_pct: 7, amenities: ['24/7 Security', 'Power supply', 'Clubhouse', 'Parking', 'Gated estate', 'Paved roads', 'Water treatment'],
    images: [img('1568605114967-8130f3a36994'), img('1574362848149-11496d93a7c7'), img('1484154218962-a197022b5858')], createdDays: -900,
  }, [
    { name: '4 Bedroom Terrace', bedrooms: 4, size_sqm: 260, price_kobo: N(145_000_000), total_units: 28, available_units: 4 },
    { name: '5 Bedroom Terrace + Penthouse', bedrooms: 5, size_sqm: 340, price_kobo: N(195_000_000), total_units: 12, available_units: 1 },
  ]);
  project('lugbe', U.greenfield, {
    name: 'Greenfield Gardens Lugbe', tagline: 'Affordable 2 & 3-bed bungalows on the airport road', kind: 'residential', status: 'off_plan', city: 'Abuja', area: 'Lugbe', address: 'Airport Road, Lugbe',
    description: 'Detached bungalows for first-time buyers and investors, with a 24-month payment plan. Groundbreaking in January; the show home is open on Saturdays.',
    progress_pct: 5, launch_date: day(-20), completion_date: day(720), title_document: 'C of O', payment_plan: '20% deposit, balance over 24 months. Mortgage partners available.',
    min_investment_kobo: N(5_500_000), expected_roi_pct: 35, rental_yield_pct: 9, amenities: ['24/7 Security', 'Gated estate', 'Children’s play area', 'Drainage'],
    images: [img('1580587771525-78b9dba3b914'), img('1564013799919-ab600027ffc6')], createdDays: -20,
  }, [
    { name: '2 Bedroom Bungalow', bedrooms: 2, size_sqm: 110, price_kobo: N(27_500_000), total_units: 50, available_units: 47 },
    { name: '3 Bedroom Bungalow', bedrooms: 3, size_sqm: 150, price_kobo: N(38_000_000), total_units: 40, available_units: 38 },
  ]);
  // A draft so the developer sees the publish flow.
  project('ikoyi', U.landmark, {
    name: 'The Ikoyi Edit (draft)', tagline: 'Boutique 3-bed apartments, Bourdillon Road', kind: 'residential', status: 'off_plan', city: 'Lagos', area: 'Ikoyi', published: false,
    description: 'Planning stage. Final pricing pending.', progress_pct: 0, completion_date: day(900), images: [img('1493809842364-78817add7ffb')], createdDays: -5,
  }, [{ name: '3 Bedroom Apartment', bedrooms: 3, size_sqm: 210, price_kobo: N(450_000_000), total_units: 18, available_units: 18 }]);

  update('palmgrove', 0, -280, 'Groundbreaking ceremony', 'Phase 1 groundbreaking done with the Ibeju-Lekki LGA chairman. Site clearing complete.', 5, [img('1500382017468-9049fed747ef')]);
  update('palmgrove', 1, -150, 'Foundations complete for 40 units', 'All Phase 1 foundations have been cast and certified by our structural engineers.', 22);
  update('palmgrove', 2, -40, 'Roofing started on Block A', 'Block A is at roofing stage; Blocks B–C at lintel level. On schedule for Q3 2027 handover.', 45, [img('1570129477492-45c003edd2be')]);
  update('cityscape', 0, -400, 'Piling complete', 'Deep piling finished ahead of schedule.', 15);
  update('cityscape', 1, -120, 'Topped out at floor 22', 'The concrete frame is complete. Facade glazing begins next month.', 60);
  update('cityscape', 2, -12, 'Show apartment open', 'Book a viewing of the furnished show studio on floor 9.', 68);
  update('katampe', 0, -60, 'Handover complete', 'All sold units handed over. 5 units left for sale, ready to move in.', 100);
  update('lugbe', 0, -10, 'Show home open', 'The 3-bed show home is open every Saturday 10am–4pm.', 5);
  update('epeplots', 0, -30, 'Survey registered', 'Estate survey registered with the Surveyor-General. Perimeter fencing starts in two weeks.', 10);

  // Leads, each with a chat and opening message.
  const lead = (key, projectKey, investor, unitIdx, o, chat = []) => {
    const pr = P[projectKey]; const unit = unitIdx == null ? null : UT[`${projectKey}:${unitIdx}`];
    const convo = { id: sid('conv:' + key), context_type: 'project', context_id: pr.id, participant_a: investor, participant_b: pr.developer_id, created_at: at(o.days, 9) };
    rows.conversations.push(convo);
    const first = [`${o.kind === 'reservation' ? 'Reservation request' : o.kind === 'inspection' ? 'Site inspection request' : 'Enquiry'} for ${pr.name}`, unit ? `${o.units ?? 1} × ${unit.name}` : null, o.message].filter(Boolean).join('\n');
    [['a', first], ...chat].forEach(([from, body], i) => rows.messages.push({ id: sid(`msg:${key}:${i}`), conversation_id: convo.id, sender_id: from === 'a' ? investor : pr.developer_id, body, read_at: at(o.days + i * 0.1 + 0.05, 12), created_at: at(o.days + i * 0.1, 10 + i) }));
    rows.dev_leads.push({ id: sid('lead:' + key), project_id: pr.id, developer_id: pr.developer_id, investor_id: investor, unit_type_id: unit?.id ?? null, kind: o.kind, units: o.units ?? 1, budget_kobo: o.budget ?? null,
      message: o.message ?? null, status: o.status, agreed_kobo: o.agreed ?? null, developer_note: o.note ?? null, conversation_id: convo.id, created_at: at(o.days, 9), updated_at: at(o.days + (o.status === 'new' ? 0 : 3), 15) });
  };
  lead('ngozi-palm', 'palmgrove', U.ngozi, 1, { kind: 'reservation', units: 2, status: 'purchased', agreed: N(148_200_000), days: -200, note: 'Paid outright, 5% discount applied. Allocation letters sent.', message: 'I would like two units for rental. Is the 5% outright discount still on?' },
    [['b', 'Good afternoon Ngozi. Yes, 5% off for outright payment. I have sent the offer letter and our account details by email.'], ['a', 'Payment made. Please confirm receipt.'], ['b', 'Confirmed, thank you! Allocation letters for Units B14 and B15 are attached to your email.']]);
  lead('ngozi-city', 'cityscape', U.ngozi, 0, { kind: 'reservation', units: 1, status: 'reserved', agreed: N(68_000_000), days: -45, note: '40% deposit received. Joined rental programme.', message: 'Interested in a studio with the rental-management programme.' },
    [['b', 'Great choice. Studios on floors 12–16 have the best lagoon views. Shall I hold 14C for you?'], ['a', 'Yes please, deposit sent today.']]);
  lead('ngozi-katampe', 'katampe', U.ngozi, 0, { kind: 'inspection', status: 'contacted', days: -6, message: 'I will be in Abuja on the 14th. Can I see a 4-bed?' }, [['b', 'Of course. Our sales lead will meet you at the gate at 11am on the 14th.']]);
  lead('kunle-epe', 'epeplots', U.kunle, 0, { kind: 'reservation', units: 2, status: 'negotiating', days: -9, message: 'Two adjacent 300 m² plots. Can the deposit be split across 2 months?' }, [['b', 'We can do ₦2M now and ₦2M next month. Shall I send the allocation form?']]);
  lead('kunle-palm', 'palmgrove', U.kunle, 0, { kind: 'enquiry', budget: N(40_000_000), status: 'declined', days: -70, message: 'Any smaller units under ₦40M?' }, [['b', 'Sorry, our smallest unit here is ₦55M. Lagoon View Plots in Epe could suit your budget.']]);
  lead('amaka-lugbe', 'lugbe', U.amaka, 1, { kind: 'reservation', status: 'new', days: -1, message: 'Family of four, looking at the 3-bed. Do you work with any mortgage banks?' });
  lead('amaka-katampe', 'katampe', U.amaka, 0, { kind: 'enquiry', budget: N(90_000_000), status: 'withdrawn', days: -30, message: 'Is there a payment plan on the 4-bed?' }, [['b', 'For completed units we ask for 50% upfront and the balance within 6 months.'], ['a', 'That is above my budget for now, thanks.']]);
  if (existing.has(EXISTING.tunde)) lead('tunde-lugbe', 'lugbe', EXISTING.tunde, 0, { kind: 'enquiry', status: 'new', days: -0.3, message: 'I rent in Gwarinpa now. Could the 2-bed work with my rent budget as monthly instalments?' });
  if (existing.has(EXISTING.chinedu)) lead('chinedu-city', 'cityscape', EXISTING.chinedu, 2, { kind: 'enquiry', status: 'contacted', days: -15, message: 'I have two clients interested in 2-bed units. Do you pay agent commission?' }, [['b', 'Yes, 3% on completed sales. I will send you our agent pack.']]);

  const watch = (user, key, days) => rows.dev_watchlist.push({ user_id: user, project_id: P[key].id, created_at: at(days) });
  watch(U.ngozi, 'lugbe', -8); watch(U.ngozi, 'epeplots', -20); watch(U.kunle, 'palmgrove', -60); watch(U.kunle, 'cityscape', -12); watch(U.amaka, 'katampe', -31); watch(U.amaka, 'palmgrove', -14);
  if (existing.has(EXISTING.amara)) watch(EXISTING.amara, 'lugbe', -3);

  let ni = 0;
  const notify = (user, type, title, body, data, days, read = true) => rows.notifications.push({ id: sid('notif:' + ni++), user_id: user, type, title, body, data, read_at: read ? at(days, 20) : null, created_at: at(days, 9) });
  notify(U.greenfield, 'dev_lead', 'New reservation request', `Amaka Okafor: Greenfield Gardens Lugbe · 3 Bedroom Bungalow`, { leadId: sid('lead:amaka-lugbe') }, -1, false);
  notify(U.landmark, 'dev_lead', 'New reservation request', 'Kunle Bakare: Lagoon View Plots · 300 m² plot', { leadId: sid('lead:kunle-epe') }, -9);
  notify(U.ngozi, 'dev_update', 'Cityscape Towers: Show apartment open', 'Book a viewing of the furnished show studio on floor 9.', { projectId: P.cityscape.id }, -12, false);
  notify(U.ngozi, 'dev_lead', 'Cityscape Towers', 'Your unit is reserved 🎉', { leadId: sid('lead:ngozi-city') }, -42);
  notify(U.kunle, 'dev_update', 'Palm Grove Residences: Roofing started on Block A', 'Construction is now 45% complete.', { projectId: P.palmgrove.id }, -40);
  notify(U.amaka, 'dev_update', 'Katampe Hills Terraces: Handover complete', 'All sold units handed over. 5 units left for sale.', { projectId: P.katampe.id }, -60);
  return rows;
}

const ORDER = ['dev_projects', 'dev_unit_types', 'dev_project_updates', 'conversations', 'messages', 'dev_leads', 'dev_watchlist', 'notifications'];
const KEY = { dev_watchlist: 'user_id,project_id' };

const probe = await db.from('dev_projects').select('id', { head: true, count: 'exact' }).limit(1);
if (probe.error) { console.error('✖ Run migration 028_developers_investors.sql in Supabase first.\n  ' + probe.error.message); process.exit(1); }

if (CLEAN) {
  for (const a of Object.values(ACCOUNTS)) {
    const u = await findUser(a.email);
    if (!u) continue;
    // Their projects, leads, chats and watchlist go with the profile (on delete cascade); chats need deleting first.
    const { data: convos } = await db.from('conversations').select('id').or(`participant_a.eq.${u.id},participant_b.eq.${u.id}`).eq('context_type', 'project');
    if (convos?.length) await must(db.from('conversations').delete().in('id', convos.map((c) => c.id)), 'conversations');
    await must(db.from('notifications').delete().eq('user_id', u.id), 'notifications');
    const { error } = await db.auth.admin.deleteUser(u.id);
    console.log(error ? `could not delete ${a.email}: ${error.message}` : `deleted  ${a.email}`);
  }
  // Rows involving existing users (their watchlist entries / enquiries were on deleted projects, so they're gone too).
  console.log('Sample developers, investors and projects removed.');
  process.exit(0);
}

if (DRY) {
  const fake = Object.fromEntries(Object.keys(ACCOUNTS).map((k) => [k, sid('user:' + k)]));
  Object.keys(EXISTING_EMAILS).forEach((k) => { EXISTING[k] = sid('existing:' + k); });
  const rows = build(fake, new Set(Object.values(EXISTING)));
  for (const t of ORDER) console.log(`would seed ${t.padEnd(22)} ${rows[t].length}`);
  console.log(`would create ${Object.keys(ACCOUNTS).length} accounts: ${Object.values(ACCOUNTS).map((a) => a.email).join(', ')}`);
  process.exit(0);
}

const U = await ensureAccounts();
for (const [k, email] of Object.entries(EXISTING_EMAILS)) { const u = await findUser(email); EXISTING[k] = u?.id ?? `missing:${k}`; }
const rows = build(U, new Set(Object.values(EXISTING).filter((x) => !x.startsWith('missing:'))));
for (const t of ORDER) {
  if (!rows[t].length) continue;
  await must(db.from(t).upsert(rows[t], { onConflict: KEY[t] ?? 'id' }), t);
  console.log(`seeded   ${t.padEnd(22)} ${rows[t].length}`);
}
console.log(`\nDone. Sample accounts (password: ${PASSWORD}):`);
for (const a of Object.values(ACCOUNTS)) console.log(`  ${a.role.padEnd(9)} ${a.email}`);
console.log('\nRemove it all later with: node scripts/seed-developers-investors.mjs --clean');
