// Sample data for every part of RentCreeb, attached to the accounts that are already registered.
//
//   node scripts/seed-sample-data.mjs           insert / refresh the sample data (safe to re-run)
//   node scripts/seed-sample-data.mjs --clean   remove everything this script added
//
// Every row gets a deterministic id (hash of a seed key), so re-running updates rows instead of duplicating them and
// --clean knows exactly what to delete. Nothing existing is overwritten: profiles, wallet balances and app settings are
// left alone, and bank accounts / artisan profiles are only added where the user has none.
import 'dotenv/config';
import { createHash } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';

const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const CLEAN = process.argv.includes('--clean');
const DRY = process.argv.includes('--dry');

// ───────── helpers ─────────
const sid = (key) => {
  const h = createHash('sha1').update('rentcreeb-seed:' + key).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
};
const NOW = new Date(); NOW.setUTCMinutes(0, 0, 0);
const at = (days, hour = 10, min = 0) => {
  const whole = Math.floor(days), d = new Date(NOW.getTime() + whole * 864e5);
  d.setUTCHours(hour, min, 0, 0);
  let t = d.getTime() + (days - whole) * 864e5;
  if (days <= 0 && t > NOW.getTime()) t = NOW.getTime() - 5 * 60000; // "today" events never land in the future
  return new Date(t).toISOString();
};
const day = (days) => at(days).slice(0, 10);
const N = (naira) => Math.round(naira * 100); // naira → kobo
const img = (id) => `https://images.unsplash.com/photo-${id}?w=1200&q=80`;
const rows = {}; // table → rows, in insert order
const add = (table, row) => { (rows[table] ??= []).push(row); return row; };

// ───────── registered users ─────────
const U = {
  isreal: 'd7127eb9-e837-46fd-8599-e42ee319869b',   // tenant
  amara: '44444444-4444-4444-8444-444444444444',    // tenant
  tunde: '33333333-3333-4333-8333-333333333333',    // tenant
  anon: 'c097fb84-5862-405e-8be2-be6f05c49298',     // tenant (no name yet)
  dolapoT: '595c874d-fbd9-48b6-9b43-5baeb208d409',  // tenant
  adebayo: '11111111-1111-4111-8111-111111111111',  // landlord
  olapade: 'a61bb547-618a-4203-983d-fd5fd9e22566',  // estate manager
  oyakilome: '88888888-8888-4888-8888-888888888888',// estate manager
  akindola: '09d342db-3747-4ebd-b248-9179a19986d6', // estate manager
  chinedu: '55555555-5555-4555-8555-555555555555',  // agent
  musa: '66666666-6666-4666-8666-666666666666',     // artisan (plumbing)
  emeka: '77777777-7777-4777-8777-777777777777',    // artisan (electrical)
  dolapoA: '5efba15e-551f-4d34-8305-b2a6658fe940',  // artisan (not onboarded yet)
  funmi: '22222222-2222-4222-8222-222222222222',    // admin
};
const TENANTS = [U.isreal, U.amara, U.tunde, U.anon, U.dolapoT];

// ───────── properties ─────────
const P = {};
function property(key, owner, p, extra = {}) {
  const id = sid('prop:' + key);
  const created = at(p.createdDays ?? -40);
  P[key] = add('properties', {
    id, owner_id: owner, title: p.title, description: p.description, address: p.address, area: p.area, city: 'Lagos', state: 'Lagos',
    lat: p.lat, lng: p.lng, price_kobo: p.price, price_period: p.period ?? 'year', property_type: p.type, bedrooms: p.beds ?? 0, bathrooms: p.baths ?? 0,
    size_sqm: p.size ?? null, parking: (p.parkingSpaces ?? 0) > 0, parking_spaces: p.parkingSpaces ?? 0, amenities: p.amenities ?? [],
    security_features: p.security ?? [], inspection_fee_kobo: p.fee ?? N(5000), caution_fee_kobo: p.caution ?? null, agency_fee_kobo: p.agency ?? null,
    year_built: p.year ?? null, landmark: p.landmark ?? null, status: p.status ?? 'approved', rejection_reason: p.rejection ?? null,
    is_verified: (p.status ?? 'approved') === 'approved' || p.status === 'rented', unit_mode: p.unitMode ?? 'single',
    title_document: p.titleDoc ?? null, plot_count: p.plots ?? null, commercial_use: p.use ?? null,
    created_at: created, updated_at: created, ...extra,
  });
  (p.photos ?? []).forEach((ph, i) => add('property_media', { id: sid(`media:${key}:${i}`), property_id: id, url: img(ph), media_type: 'image', position: i }));
  (p.nearby ?? []).forEach(([category, name, km, rating], i) => add('nearby_places', { id: sid(`near:${key}:${i}`), property_id: id, category, name, distance_km: km, rating }));
  const units = p.units ?? [['Main', p.unitType ?? '2_bed', p.period === 'outright' ? 0 : p.period === 'month' ? p.price : Math.round(p.price / 12), p.size ?? null, Math.max(p.baths ?? 1, 1), p.status === 'rented' ? 'occupied' : 'vacant']];
  units.forEach(([label, unit_type, rent_kobo, size_sqm, bathrooms, status]) =>
    add('units', { id: sid(`unit:${key}:${label}`), property_id: id, label, unit_type, rent_kobo, size_sqm, bathrooms, status, created_at: created }));
  const pending = p.status === 'pending' || p.status === 'rejected';
  add('listing_ai_reviews', {
    property_id: id, status: 'done', stage: null, queued_at: created, started_at: created, finished_at: created, listing_updated_at: created,
    decision: pending ? 'needs_admin' : 'auto_approved', attempts: 0, updated_at: created,
    review: {
      decision: pending ? 'needs_admin' : 'auto_approved',
      checks: [
        { key: 'owner_verified', ok: true, label: 'Owner identity verified' },
        { key: 'photos', ok: (p.photos ?? []).length >= 3, label: 'At least 3 photos', soft: true },
        { key: 'no_contact_details', ok: true, label: 'No phone numbers or emails in the description' },
      ],
      ai: { verdict: pending ? 'needs_review' : 'approve', confidence: pending ? 0.62 : 0.93,
        summary: pending ? 'Listing looks genuine but the price is well above similar homes in the area.' : 'Clear photos that match the description and a realistic price for the area.',
        issues: pending ? ['Price is about 40% above comparable listings in Magodo'] : [], photos: [] },
      reasons: pending ? ['AI confidence below the auto-approval threshold'] : [],
    },
  });
  return P[key];
}
const unitId = (key, label = 'Main') => sid(`unit:${key}:${label}`);

property('ikoyiDuplex', U.adebayo, {
  title: '4 Bedroom Semi-Detached Duplex with BQ', type: 'duplex', beds: 4, baths: 5, size: 320, price: N(12_000_000), fee: N(15000), caution: N(1_000_000), agency: N(1_200_000),
  description: 'Tastefully finished duplex in a quiet, gated close off Bourdillon Road. Fitted kitchen, family lounge, en-suite rooms, a one-room boys quarters and space for three cars.',
  address: '12 Mekunwen Road, Ikoyi, Lagos', area: 'Ikoyi', lat: 6.4535, lng: 3.4339, parkingSpaces: 3, year: 2019, landmark: 'Off Bourdillon Road',
  amenities: ['24/7 Power', 'Borehole', 'Fitted Kitchen', 'Boys Quarters', 'Parking', 'Air Conditioning'], security: ['Access Gate', 'CCTV', 'Security Guard'],
  photos: ['1613490493576-7fde63acd811', '1600596542815-ffad4c1539a9', '1600585154340-be6161a56a0c', '1600566753190-17f0baa2a6c3'],
  nearby: [['education', 'Grange School Ikoyi', 1.4, 4.6], ['healthcare', 'St. Nicholas Hospital Ikoyi', 2.1, 4.4], ['markets', 'Ikoyi Shopping Mall', 1.8, 4.2], ['transport', 'Falomo Bus Stop', 1.2, 3.9]],
  unitType: '4_bed', createdDays: -60,
});
property('yabaSelfCon', U.adebayo, {
  title: 'Neat Self-Contain near UNILAG', type: 'self-contain', beds: 1, baths: 1, size: 28, price: N(650_000), fee: N(3000), caution: N(100_000),
  description: 'Clean self-contain room with private kitchenette and bathroom, five minutes walk from the UNILAG main gate. Prepaid meter and steady water.',
  address: '7 Abule-Oja Street, Akoka, Yaba, Lagos', area: 'Yaba', lat: 6.5175, lng: 3.3891, status: 'rented',
  amenities: ['Prepaid Meter', 'Water Supply', 'Tiled Floors'], security: ['Access Gate'],
  photos: ['1522708323590-d24dbb6b0267', '1502672260266-1c1ef2d93688', '1554995207-c18c203602cb'],
  nearby: [['education', 'University of Lagos', 0.6, 4.5], ['transport', 'Abule-Oja Bus Stop', 0.3, 3.8], ['markets', 'Yaba Market', 1.9, 4.0]],
  unitType: 'studio', createdDays: -320,
});
property('harmonyCourt', U.olapade, {
  title: 'Harmony Court – 2 Bedroom Flats', type: 'apartment', beds: 2, baths: 2, size: 95, price: N(2_400_000), fee: N(5000), caution: N(200_000), agency: N(240_000),
  description: 'Block of four identical 2 bedroom flats in a serviced compound. Shared generator, treated borehole water and a resident caretaker.',
  address: '24 Ifoshi Street, Gbagada Phase 2, Lagos', area: 'Gbagada', lat: 6.5562, lng: 3.3876, parkingSpaces: 6, year: 2021, landmark: 'Behind Gbagada General Hospital',
  amenities: ['Generator', 'Borehole', 'Parking', 'Caretaker', 'Balcony'], security: ['Access Gate', 'Security Guard'], unitMode: 'same',
  photos: ['1545324418-cc1a3fa10c00', '1560448204-e02f11c3d0e2', '1493809842364-78817add7ffb', '1484154218962-a197022b5858'],
  nearby: [['healthcare', 'Gbagada General Hospital', 0.4, 3.9], ['transport', 'Gbagada Phase 2 Bus Stop', 0.7, 3.7], ['religious', 'RCCG Sure Foundation Parish', 0.9, 4.3]],
  units: [['Flat 1A', '2_bed', N(200_000), 95, 2, 'occupied'], ['Flat 1B', '2_bed', N(200_000), 95, 2, 'vacant'], ['Flat 2A', '2_bed', N(200_000), 95, 2, 'occupied'], ['Flat 2B', '2_bed', N(200_000), 95, 2, 'vacant']],
  createdDays: -280,
});
property('magodoBungalow', U.olapade, {
  title: '3 Bedroom Bungalow with Large Compound', type: 'bungalow', beds: 3, baths: 3, size: 210, price: N(7_000_000), fee: N(10000),
  description: 'Detached bungalow on a full plot inside Magodo GRA Phase 2. Big compound, all rooms en-suite, guest toilet and a separate laundry room.',
  address: '5 Adebayo Mokuolu Street, Magodo GRA Phase 2, Lagos', area: 'Magodo', lat: 6.6206, lng: 3.3815, parkingSpaces: 4, year: 2012,
  amenities: ['Borehole', 'Parking', 'Garden', 'Laundry Room'], security: ['Access Gate', 'Electric Fencing'], status: 'pending',
  photos: ['1570129477492-45c003edd2be', '1564013799919-ab600027ffc6', '1568605114967-8130f3a36994'],
  nearby: [['education', 'Lagos State Model College Kankon', 2.3, 4.1], ['security', 'Magodo Police Post', 0.8, 3.6]],
  unitType: '3_bed', createdDays: -1,
});
property('palmGrove', U.oyakilome, {
  title: 'Palm Grove Residences – Mixed Units', type: 'apartment', beds: 3, baths: 3, size: 140, price: N(3_600_000), fee: N(5000), caution: N(150_000),
  description: 'Mixed block with a studio, a 1 bedroom and a 3 bedroom flat. Close to the National Stadium and Adeniran Ogunsanya mall.',
  address: '18 Bode Thomas Street, Surulere, Lagos', area: 'Surulere', lat: 6.4965, lng: 3.3561, parkingSpaces: 3, year: 2016,
  amenities: ['Generator', 'Water Supply', 'Parking'], security: ['Access Gate', 'CCTV'], unitMode: 'mixed',
  photos: ['1512917774080-9991f1c4c750', '1505691938895-1758d7feb511', '1536376072261-38c75010e6c9'],
  nearby: [['markets', 'Adeniran Ogunsanya Shopping Mall', 0.9, 4.3], ['transport', 'Barracks Bus Stop', 1.1, 3.8], ['utilities', 'Ikeja Electric Surulere Office', 1.5, 3.2]],
  units: [['Studio G1', 'studio', N(120_000), 30, 1, 'occupied'], ['Flat 1', '1_bed', N(180_000), 55, 1, 'vacant'], ['Flat 2', '3_bed', N(300_000), 140, 3, 'vacant']],
  createdDays: -200,
});
property('ogbaMiniFlat', U.oyakilome, {
  title: 'Mini Flat in a Quiet Ogba Estate', type: 'apartment', beds: 1, baths: 1, size: 48, price: N(1_100_000), fee: N(3000),
  description: 'Spacious mini flat (room and parlour) with POP ceiling, wardrobe and a big kitchen. Estate has a security gate and good road.',
  address: '3 Oluwole Fagbemi Close, Ogba, Ikeja, Lagos', area: 'Ogba', lat: 6.6278, lng: 3.3417, parkingSpaces: 1, status: 'paused',
  amenities: ['Prepaid Meter', 'Wardrobe', 'POP Ceiling'], security: ['Access Gate'],
  photos: ['1494526585095-c41746248156', '1560185127-6ed189bf02f4', '1556909114-f6e7ad7d3136'],
  unitType: '1_bed', createdDays: -150,
});
property('ajahTerrace', U.akindola, {
  title: '3 Bedroom Terrace Duplex in Gated Estate', type: 'terrace', beds: 3, baths: 4, size: 180, price: N(5_500_000), fee: N(7500), caution: N(500_000), agency: N(550_000),
  description: 'Modern terrace duplex with a rooftop terrace, fitted kitchen and a guest toilet. Estate has paved roads, street lights and a children\'s play area.',
  address: 'Thomas Estate, Badore Road, Ajah, Lagos', area: 'Ajah', lat: 6.4698, lng: 3.5852, parkingSpaces: 2, year: 2022, landmark: 'Opposite Abraham Adesanya Estate',
  amenities: ['Fitted Kitchen', 'Rooftop Terrace', 'Parking', 'Borehole', 'Playground'], security: ['Access Gate', 'Security Guard', 'CCTV'], status: 'rented',
  photos: ['1580587771525-78b9dba3b914', '1600047509807-ba8f99d2cdde', '1600573472550-8090b5e0745e'],
  nearby: [['education', 'Greensprings School Lekki', 3.2, 4.5], ['markets', 'Ajah Market', 2.0, 3.7], ['transport', 'Abraham Adesanya Roundabout', 1.4, 3.8]],
  unitType: '3_bed', createdDays: -130,
});
property('ikejaGra', U.akindola, {
  title: '2 Bedroom Flat, Ikeja GRA', type: 'apartment', beds: 2, baths: 2, size: 100, price: N(3_200_000), fee: N(5000),
  description: 'Two bedroom flat close to the airport road.', address: 'Isaac John Street, Ikeja GRA, Lagos', area: 'Ikeja GRA', lat: 6.5788, lng: 3.3511,
  amenities: ['Parking'], status: 'rejected',
  rejection: 'Photos show a different building from the address given. Please upload photos of this flat and add a fuller description.',
  photos: ['1574362848149-11496d93a7c7'], unitType: '2_bed', createdDays: -20,
});
property('viStudio', U.chinedu, {
  title: 'Furnished Studio, Victoria Island', type: 'studio', beds: 1, baths: 1, size: 40, price: N(450_000), period: 'month', fee: N(10000), caution: N(450_000),
  description: 'Fully furnished studio with fast internet, smart TV and 24 hour power. Ideal for young professionals working on the Island.',
  address: '28 Ahmed Onibudo Street, Victoria Island, Lagos', area: 'Victoria Island', lat: 6.4311, lng: 3.4215, parkingSpaces: 1, year: 2020,
  amenities: ['Furnished', '24/7 Power', 'Wi-Fi', 'Air Conditioning', 'Gym'], security: ['CCTV', 'Security Guard', 'Access Gate'],
  photos: ['1536376072261-38c75010e6c9', '1502005229762-cf1b2da7c5d6', '1586023492125-27b2c045efd7'],
  nearby: [['transport', 'Bonny Camp Bus Stop', 0.9, 3.9], ['healthcare', 'Reddington Hospital VI', 1.1, 4.5], ['markets', 'The Palms Lekki', 4.5, 4.4]],
  unitType: 'studio', createdDays: -90,
});
property('lekkiOffice', U.chinedu, {
  title: 'Open-Plan Office Space on Admiralty Way', type: 'commercial', baths: 2, size: 250, price: N(9_000_000), fee: N(10000), use: 'Office space', agency: N(900_000),
  description: 'Second floor open-plan office (250 sqm) with a reception, two meeting rooms, kitchenette and dedicated parking for 5 cars.',
  address: '15 Admiralty Way, Lekki Phase 1, Lagos', area: 'Lekki Phase 1', lat: 6.4478, lng: 3.4723, parkingSpaces: 5, year: 2018,
  amenities: ['24/7 Power', 'Elevator', 'Air Conditioning', 'Parking'], security: ['CCTV', 'Access Gate', 'Security Guard'],
  photos: ['1497366216548-37526070297c', '1497366811353-6870744d04b2', '1524758631624-e2822e304c36'],
  nearby: [['transport', 'Admiralty Way Bus Stop', 0.2, 3.9], ['markets', 'Lekki Phase 1 Shops', 0.5, 4.0]],
  unitType: 'other', createdDays: -75,
});
property('ibejuLand', U.chinedu, {
  title: '600 sqm Dry Land with C of O, Ibeju-Lekki', type: 'land', size: 600, price: N(25_000_000), period: 'outright', fee: N(5000), plots: 1,
  titleDoc: 'Certificate of Occupancy (C of O)',
  description: 'Fenced, dry and sand-filled plot in a fast-developing estate, ten minutes from the Lekki Free Trade Zone and Dangote Refinery.',
  address: 'Eleko Junction, Ibeju-Lekki, Lagos', area: 'Ibeju-Lekki', lat: 6.4549, lng: 3.8417,
  amenities: ['Fenced', 'Good Road'], photos: ['1500382017468-9049fed747ef', '1500076656116-558758c991c1', '1464822759023-fed622ff2c3b'],
  nearby: [['transport', 'Eleko Junction', 0.8, 3.5]], unitType: 'other', createdDays: -45,
});

// Documents on private storage (paths only) and listing views.
add('property_documents', { id: sid('pdoc:harmony:title'), property_id: P.harmonyCourt.id, doc_type: 'title', storage_path: `property-docs/${P.harmonyCourt.id}/certificate-of-occupancy.pdf`, original_name: 'Harmony Court C of O.pdf', size_bytes: 842113, created_at: at(-270) });
add('property_documents', { id: sid('pdoc:ajah:survey'), property_id: P.ajahTerrace.id, doc_type: 'survey', storage_path: `property-docs/${P.ajahTerrace.id}/survey-plan.pdf`, original_name: 'Thomas Estate survey plan.pdf', size_bytes: 1203344, created_at: at(-125) });
add('property_documents', { id: sid('pdoc:ikoyi:agreement'), property_id: P.ikoyiDuplex.id, doc_type: 'agreement', storage_path: `property-docs/${P.ikoyiDuplex.id}/tenancy-agreement-template.pdf`, original_name: 'Tenancy agreement template.pdf', size_bytes: 214560, created_at: at(-58) });

const viewCounts = { ikoyiDuplex: 42, harmonyCourt: 31, palmGrove: 18, viStudio: 57, lekkiOffice: 12, ibejuLand: 26, ajahTerrace: 9, yabaSelfCon: 6 };
const VIEWS = [];
Object.entries(viewCounts).forEach(([key, n], k) => {
  for (let i = 0; i < n; i++) VIEWS.push({ property_id: P[key].id, viewer_id: i % 3 === 0 ? null : TENANTS[(i + k) % TENANTS.length], created_at: at(-((i * 7 + k) % 14), 8 + (i % 12), (i * 13) % 60) });
});

// ───────── tenancies, rent, renewals, reminders, RentSave ─────────
const T = {};
function tenancy(key, t) { T[key] = add('tenancies', { id: sid('ten:' + key), status: 'active', created_at: at(-200), ...t }); return T[key]; }
tenancy('isrealHarmony', { property_id: P.harmonyCourt.id, unit_id: unitId('harmonyCourt', 'Flat 1A'), unit_label: 'Flat 1A', landlord_id: U.olapade, tenant_id: U.isreal,
  lease_start: '2026-03-01', lease_end: '2027-02-28', rent_kobo: N(2_400_000), frequency: 'yearly', next_due_date: '2027-03-01',
  emergency_contact_name: 'Mrs. Bisi Akindola', emergency_contact_phone: '+2348000000201', created_at: at(-265) });
tenancy('inviteHarmony', { property_id: P.harmonyCourt.id, unit_id: unitId('harmonyCourt', 'Flat 2A'), unit_label: 'Flat 2A', landlord_id: U.olapade, tenant_id: null,
  invite_name: 'Kemi Adeyemi', invite_email: 'kemi.adeyemi@example.com', invite_phone: '+2348000000101',
  lease_start: day(-10), lease_end: day(355), rent_kobo: N(2_400_000), frequency: 'yearly', next_due_date: day(356), created_at: at(-12) });
tenancy('anonPalm', { property_id: P.palmGrove.id, unit_id: unitId('palmGrove', 'Studio G1'), unit_label: 'Studio G1', landlord_id: U.oyakilome, tenant_id: U.anon,
  lease_start: '2026-06-01', lease_end: '2027-05-31', rent_kobo: N(120_000), frequency: 'monthly', next_due_date: '2026-11-01', created_at: at(-172) });
tenancy('tundeAjah', { property_id: P.ajahTerrace.id, unit_id: unitId('ajahTerrace'), unit_label: 'Unit 4', landlord_id: U.akindola, tenant_id: U.tunde,
  lease_start: '2026-08-01', lease_end: '2027-07-31', rent_kobo: N(1_375_000), frequency: 'quarterly', next_due_date: '2026-11-01',
  emergency_contact_name: 'Bola Bakare', emergency_contact_phone: '+2348000000202', created_at: at(-112) });
tenancy('dolapoYaba', { property_id: P.yabaSelfCon.id, unit_id: unitId('yabaSelfCon'), unit_label: 'Room 3', landlord_id: U.adebayo, tenant_id: U.dolapoT,
  lease_start: '2026-01-15', lease_end: '2027-01-14', rent_kobo: N(650_000), frequency: 'yearly', next_due_date: '2027-01-15', created_at: at(-310) });

// Payments (all Paystack-style references are clearly marked as seed data).
const PAY = {};
function payment(key, p) { PAY[key] = add('payments', { id: sid('pay:' + key), reference: `RC-SEED-${key.toUpperCase()}`, status: 'success', channel: 'card', ...p }); return PAY[key]; }

function rent(key, tenancyKey, amount, due, status, method = 'paystack', extra = {}) {
  const t = T[tenancyKey];
  let payment_id = null;
  if (status === 'paid' && method === 'paystack' && t.tenant_id) {
    payment_id = payment('rent:' + key, { user_id: t.tenant_id, purpose: 'rent', amount_kobo: amount, tenancy_id: t.id, paid_at: due + 'T09:30:00Z', created_at: due + 'T09:25:00Z' }).id;
    add('wallet_transactions', { id: sid('wtx:rent:' + key), user_id: t.landlord_id, direction: 'credit', amount_kobo: amount, kind: 'rent', description: `Rent payment – ${t.unit_label}`, reference: `seed:rent:${key}`, created_at: due + 'T09:31:00Z' });
  }
  add('rent_payments', { id: sid('rent:' + key), tenancy_id: t.id, amount_kobo: amount, due_date: due, status, method, payment_id,
    paid_at: status === 'paid' ? due + 'T09:30:00Z' : null, recorded_by: method !== 'paystack' && status === 'paid' ? t.landlord_id : null, created_at: due + 'T00:00:00Z', ...extra });
}
rent('isreal-2026', 'isrealHarmony', N(2_400_000), '2026-03-01', 'paid');
rent('isreal-2027', 'isrealHarmony', N(2_400_000), '2027-03-01', 'due');
rent('invite-first', 'inviteHarmony', N(2_400_000), day(-10), 'paid', 'bank_transfer', { reference: 'GTB-TRF-7781230', notes: 'Paid before the tenant joined the app' });
['06', '07', '08', '09', '10'].forEach((m, i) =>
  rent(`anon-2026-${m}`, 'anonPalm', N(120_000), `2026-${m}-01`, 'paid', ['paystack', 'bank_transfer', 'paystack', 'cash', 'paystack'][i], i === 3 ? { notes: 'Cash collected by the caretaker' } : i === 1 ? { reference: 'OPAY-55120934' } : {}));
rent('anon-2026-11', 'anonPalm', N(120_000), '2026-11-01', 'overdue');
rent('tunde-q1', 'tundeAjah', N(1_375_000), '2026-08-01', 'paid');
rent('tunde-q2', 'tundeAjah', N(1_375_000), '2026-11-01', 'overdue');
rent('dolapo-2026', 'dolapoYaba', N(650_000), '2026-01-15', 'paid', 'rentsave', { notes: 'Paid from RentSave' });
rent('dolapo-2027', 'dolapoYaba', N(650_000), '2027-01-15', 'due');

add('lease_renewals', { id: sid('renew:isreal'), tenancy_id: T.isrealHarmony.id, landlord_id: U.olapade, new_lease_end: '2028-02-29', new_rent_kobo: N(2_640_000), status: 'pending', created_at: at(-3) });
add('lease_renewals', { id: sid('renew:dolapo'), tenancy_id: T.dolapoYaba.id, landlord_id: U.adebayo, new_lease_end: '2028-01-14', new_rent_kobo: N(700_000), status: 'accepted', created_at: at(-14), responded_at: at(-12) });
add('rent_reminders', { id: sid('remind:anon:1'), tenancy_id: T.anonPalm.id, landlord_id: U.oyakilome, channel: 'in_app', message: 'Hi, a reminder that your November rent of ₦120,000 was due on the 1st. Kindly pay this week.', created_at: at(-12) });
add('rent_reminders', { id: sid('remind:anon:2'), tenancy_id: T.anonPalm.id, landlord_id: U.oyakilome, channel: 'sms', message: 'RentCreeb: Your rent for Studio G1, Palm Grove is overdue. Please pay in the app.', created_at: at(-4) });
add('rent_reminders', { id: sid('remind:tunde:1'), tenancy_id: T.tundeAjah.id, landlord_id: U.akindola, channel: 'in_app', message: 'Good morning Tunde, the quarterly rent for Unit 4 is now overdue. Let me know if you need a few days.', created_at: at(-6) });

const PLAN = {};
function plan(key, p, contributions) {
  PLAN[key] = add('rentsave_plans', { id: sid('plan:' + key), created_at: at(-120), ...p, saved_kobo: contributions.reduce((a, [, amt]) => a + amt, 0) });
  contributions.forEach(([daysAgo, amt], i) => payment(`rentsave:${key}:${i}`, { user_id: p.tenant_id, purpose: 'rentsave', amount_kobo: amt, rentsave_plan_id: PLAN[key].id, channel: i % 2 ? 'transfer' : 'card', paid_at: at(daysAgo), created_at: at(daysAgo) }));
}
plan('isreal', { tenant_id: U.isreal, tenancy_id: T.isrealHarmony.id, name: 'Harmony Court 2027 Rent', target_kobo: N(2_640_000), contribution_kobo: N(220_000), frequency: 'monthly', target_date: '2027-02-15', status: 'active' },
  [[-110, N(220_000)], [-80, N(220_000)], [-50, N(220_000)], [-20, N(220_000)]]);
plan('amara', { tenant_id: U.amara, name: 'Next Apartment Fund', target_kobo: N(1_500_000), contribution_kobo: N(30_000), frequency: 'weekly', target_date: '2027-06-30', status: 'active' },
  Array.from({ length: 12 }, (_, i) => [-7 * (12 - i), N(30_000)]));
plan('anon', { tenant_id: U.anon, tenancy_id: T.anonPalm.id, name: 'Studio Rent Buffer', target_kobo: N(360_000), contribution_kobo: N(2_000), frequency: 'daily', target_date: '2027-05-01', status: 'paused' },
  [[-60, N(20_000)], [-45, N(20_000)], [-30, N(14_000)]]);
plan('dolapo', { tenant_id: U.dolapoT, tenancy_id: T.dolapoYaba.id, name: 'Yaba Rent 2027', target_kobo: N(700_000), contribution_kobo: N(60_000), frequency: 'monthly', target_date: '2027-01-10', status: 'completed' },
  [[-300, N(100_000)], [-240, N(150_000)], [-180, N(150_000)], [-120, N(150_000)], [-60, N(150_000)]]);

// ───────── inspection bookings, escrow, reviews, reports ─────────
const B = {};
function booking(key, tenant, propKey, scheduledDays, status, extra = {}) {
  const prop = P[propKey];
  const amount = prop.inspection_fee_kobo, fee = Math.round(amount * 0.1);
  const created = at(Math.min(scheduledDays - 3, -1), 14);
  B[key] = add('bookings', { id: sid('book:' + key), property_id: prop.id, tenant_id: tenant, host_id: prop.owner_id, scheduled_at: at(scheduledDays, 11),
    status, amount_kobo: amount, fee_kobo: fee, refund_kobo: ['refunded'].includes(status) ? amount : 0,
    confirmed_at: ['confirmed', 'completed'].includes(status) ? at(scheduledDays - 2, 9) : null, completed_at: status === 'completed' ? at(scheduledDays, 13) : null,
    created_at: created, ...extra });
  if (status === 'pending_payment' || status === 'expired') {
    payment('book:' + key, { user_id: tenant, purpose: 'inspection', amount_kobo: amount, booking_id: B[key].id, status: status === 'expired' ? 'failed' : 'pending', channel: null, paid_at: null, created_at: created });
    return B[key];
  }
  const pay = payment('book:' + key, { user_id: tenant, purpose: 'inspection', amount_kobo: amount, booking_id: B[key].id, status: status === 'refunded' ? 'refunded' : 'success', paid_at: created, created_at: created });
  const escrowStatus = status === 'completed' ? 'released' : status === 'refunded' ? 'refunded' : 'held';
  add('escrows', { id: sid('esc:book:' + key), kind: 'inspection', payment_id: pay.id, booking_id: B[key].id, payer_id: tenant, payee_id: prop.owner_id, amount_kobo: amount, fee_kobo: fee,
    status: escrowStatus, created_at: created, released_at: escrowStatus === 'released' ? at(scheduledDays, 15) : null });
  if (escrowStatus === 'released')
    add('wallet_transactions', { id: sid('wtx:book:' + key), user_id: prop.owner_id, direction: 'credit', amount_kobo: amount - fee, kind: 'escrow_release', description: `Inspection fee – ${prop.title}`, reference: `seed:escrow:book:${key}`, created_at: at(scheduledDays, 15) });
  return B[key];
}
booking('isrealVi', U.isreal, 'viStudio', -30, 'completed');
booking('isrealOffice', U.isreal, 'lekkiOffice', 5, 'confirmed');
booking('isrealOgba', U.isreal, 'ogbaMiniFlat', -50, 'expired');
booking('amaraIkoyi', U.amara, 'ikoyiDuplex', -14, 'completed');
booking('amaraLand', U.amara, 'ibejuLand', -8, 'refunded', { cancelled_reason: 'Found a plot closer to Lekki. Cancelled more than 24 hours before the visit.' });
booking('tundeVi', U.tunde, 'viStudio', -20, 'refunded', { status: 'declined', cancelled_reason: 'Agent unavailable on that date – please pick another day.' });
booking('tundeHarmony', U.tunde, 'harmonyCourt', -38, 'completed');
booking('dolapoPalm', U.dolapoT, 'palmGrove', 8, 'confirmed');
booking('dolapoAjah', U.dolapoT, 'ajahTerrace', -140, 'completed');
booking('anonIkoyi', U.anon, 'ikoyiDuplex', 7, 'paid');
booking('anonVi', U.anon, 'viStudio', 3, 'confirmed');
// The declined booking above is created via 'refunded' (for the refund money flow) then shown as declined.
B.tundeVi.refund_kobo = B.tundeVi.amount_kobo;

const R = {};
function review(key, bookingKey, rating, comment, extra = {}) {
  const b = B[bookingKey];
  R[key] = add('reviews', { id: sid('rev:' + key), property_id: b.property_id, booking_id: b.id, agent_id: b.host_id, reviewer_id: b.tenant_id, rating, comment,
    helpful_count: 0, flag_count: 0, hidden: false, created_at: at(Math.round((Date.parse(b.scheduled_at) - NOW) / 86400000) + 1, 18), ...extra });
  return R[key];
}
review('isrealVi', 'isrealVi', 5, 'Exactly like the pictures. Chinedu was on time, answered every question and even showed me the backup power room.', { agent_rating: 5, reply: 'Thank you Isreal! Glad you liked it – the unit is still available if you want it.', replied_at: at(-28) });
review('amaraIkoyi', 'amaraIkoyi', 4, 'Beautiful duplex and quiet street. The BQ needs some repainting but the landlord said it will be done before move-in.', { agent_rating: 5 });
review('tundeHarmony', 'tundeHarmony', 3, 'Flat is decent but water pressure on the first floor was weak during the visit and the caretaker was not around.', { agent_rating: 3, reply: 'Thanks for the honest feedback. We have since installed a booster pump for the upper floors.', replied_at: at(-30) });
review('dolapoAjah', 'dolapoAjah', 5, 'Very secure estate and the house is new. Process was smooth from booking to inspection.', { agent_rating: 5 });
[['isrealVi', U.amara], ['isrealVi', U.tunde], ['isrealVi', U.dolapoT], ['amaraIkoyi', U.isreal], ['tundeHarmony', U.anon], ['dolapoAjah', U.isreal], ['dolapoAjah', U.amara]].forEach(([r, u]) => {
  add('review_helpful', { review_id: R[r].id, user_id: u }); R[r].helpful_count++;
});
add('review_flags', { review_id: R.tundeHarmony.id, user_id: U.olapade, reason: 'The water issue was fixed before this review was posted.' }); R.tundeHarmony.flag_count = 1;

add('reports', { id: sid('report:tundeVi'), reporter_id: U.tunde, agent_id: U.chinedu, booking_id: B.tundeVi.id, reason: 'no_show',
  details: 'Agent declined my inspection two hours before the time after I had already left home.', status: 'investigating', admin_note: 'Contacted agent – says he had a family emergency. Awaiting proof.',
  evidence_urls: [img('1586281380349-632531db7ed4')], created_at: at(-19) });
add('reports', { id: sid('report:anonPalm'), reporter_id: U.anon, agent_id: U.oyakilome, booking_id: null, reason: 'misleading_listing',
  details: 'The listing says 24 hour generator but power is only on from 6pm to 11pm.', status: 'resolved', admin_note: 'Manager updated the listing amenities. Closed.', evidence_urls: [], created_at: at(-40) });

// ───────── saved properties & collections ─────────
const saves = [[U.isreal, 'ikoyiDuplex', N(13_000_000)], [U.isreal, 'palmGrove'], [U.isreal, 'lekkiOffice'], [U.amara, 'viStudio'], [U.amara, 'harmonyCourt'], [U.amara, 'ikoyiDuplex'],
  [U.tunde, 'ibejuLand', N(27_500_000)], [U.anon, 'harmonyCourt'], [U.dolapoT, 'viStudio'], [U.dolapoT, 'ikoyiDuplex']];
saves.forEach(([u, k, price], i) => add('saved_properties', { user_id: u, property_id: P[k].id, saved_price_kobo: price ?? P[k].price_kobo, created_at: at(-25 + i) }));
const col = (key, user, name, props) => { const c = add('saved_collections', { id: sid('col:' + key), user_id: user, name, created_at: at(-22) }); props.forEach((k) => add('saved_collection_items', { collection_id: c.id, property_id: P[k].id, created_at: at(-21) })); };
col('isreal:island', U.isreal, 'Island Options', ['ikoyiDuplex', 'lekkiOffice']);
col('amara:budget', U.amara, 'Under ₦3m', ['harmonyCourt', 'viStudio']);
col('tunde:invest', U.tunde, 'Land to Buy', ['ibejuLand']);

// ───────── maintenance, artisan jobs, quotes, reports, reviews ─────────
const M = {};
let ticket = 0;
function maintenance(key, tenancyKey, m, events) {
  const t = T[tenancyKey];
  const created = at(m.createdDays, 8);
  M[key] = add('maintenance_requests', { id: sid('mr:' + key), tenancy_id: t.id, property_id: t.property_id, tenant_id: t.tenant_id, landlord_id: t.landlord_id,
    category: m.category, description: m.description, urgency: m.urgency ?? 'standard', status: m.status, rejection_reason: m.rejection ?? null,
    ticket_no: `MR-2026-S${String(++ticket).padStart(3, '0')}`, priority: m.priority ?? 'medium',
    sla_due_at: at(m.createdDays + ({ emergency: 0.25, high: 1, medium: 3, low: 7 })[m.priority ?? 'medium'], 8), escalated_at: m.escalated ? at(m.createdDays + 1, 9) : null,
    resolved_at: m.status === 'completed' ? at(m.resolvedDays ?? m.createdDays + 4, 16) : null, created_at: created });
  (m.photos ?? []).forEach((ph, i) => add('maintenance_media', { id: sid(`mrm:${key}:${i}`), request_id: M[key].id, url: img(ph) }));
  [['submitted', t.tenant_id, 'Ticket submitted by tenant', 0], ...events].forEach(([kind, actor, note, dd], i) =>
    add('maintenance_events', { id: sid(`mre:${key}:${i}`), request_id: M[key].id, actor_id: actor, kind, note, created_at: at(m.createdDays + dd, 8 + i) }));
  return M[key];
}
maintenance('isrealShower', 'isrealHarmony', { category: 'Plumbing', description: 'Shower in the main bathroom has very low pressure and the mixer tap drips all night.', status: 'completed', priority: 'medium', createdDays: -26, resolvedDays: -19, photos: ['1584622650111-993a426fbf0a'] },
  [['reviewed', U.olapade, 'Approved – posting a job for a plumber', 0.2], ['job_posted', U.olapade, 'Job posted to artisans', 0.3], ['assigned', U.olapade, 'Musa Ibrahim assigned', 1], ['started', U.musa, 'Artisan on site', 3], ['resolved', U.olapade, 'Work confirmed complete', 7]]);
maintenance('isrealSocket', 'isrealHarmony', { category: 'Electrical', description: 'The socket behind the fridge sparks when anything is plugged in and smells of burning.', urgency: 'urgent', status: 'job_posted', priority: 'emergency', createdDays: -1, escalated: false, photos: ['1621905252507-b35492cc74b4'] },
  [['reviewed', U.olapade, 'Priority raised to emergency', 0.1], ['job_posted', U.olapade, 'Job posted to electricians', 0.15]]);
maintenance('anonAc', 'anonPalm', { category: 'AC & Cooling', description: 'The split AC in the studio blows warm air. It was serviced in June but stopped cooling last week.', status: 'open', priority: 'medium', createdDays: -2 }, []);
maintenance('tundeCeiling', 'tundeAjah', { category: 'Painting', description: 'Brown water stains spreading on the upstairs bathroom ceiling, paint is peeling. Probably a leak from the roof tank.', status: 'in_progress', priority: 'high', createdDays: -9, escalated: true, photos: ['1585128792020-803d29415281', '1558618666-fcd25c85cd64'] },
  [['escalated', null, 'SLA passed without a response – escalated', 1], ['job_posted', U.akindola, 'Job posted', 2], ['assigned', U.akindola, 'Musa Ibrahim assigned', 3], ['estimate', U.musa, 'Repair estimate submitted – ₦185,000', 5]]);
maintenance('dolapoLock', 'dolapoYaba', { category: 'General Repair', description: 'The door lock is broken and the key no longer turns.', status: 'rejected', priority: 'low', createdDays: -16,
  rejection: 'Lost or broken keys are the tenant\'s responsibility (clause 7 of the tenancy agreement). A locksmith contact has been shared in chat.' },
  [['rejected', U.adebayo, 'Tenant responsibility per lease clause 7', 1]]);

const J = {};
function job(key, j) { J[key] = add('jobs', { id: sid('job:' + key), urgency: 'standard', access_notes: null, artisan_id: null, accepted_quote_id: null, started_at: null, completed_at: null, created_at: at(-10), ...j }); return J[key]; }
function quote(key, jobKey, artisan, amount, status, breakdown, eta, notes, createdDays) {
  return add('job_quotes', { id: sid('quote:' + key), job_id: J[jobKey].id, artisan_id: artisan, amount_kobo: amount, breakdown, eta, notes, status, created_at: at(createdDays, 12) });
}
function jobEscrow(key, jobKey, quoteRow, status, releasedDays) {
  const jb = J[jobKey];
  const fee = Math.round(quoteRow.amount_kobo * 0.1);
  const pay = payment('job:' + key, { user_id: jb.landlord_id, purpose: 'job_escrow', amount_kobo: quoteRow.amount_kobo, job_id: jb.id, quote_id: quoteRow.id, paid_at: quoteRow.created_at, created_at: quoteRow.created_at });
  add('escrows', { id: sid('esc:job:' + key), kind: 'job', payment_id: pay.id, job_id: jb.id, payer_id: jb.landlord_id, payee_id: quoteRow.artisan_id, amount_kobo: quoteRow.amount_kobo, fee_kobo: fee,
    status, created_at: quoteRow.created_at, released_at: status === 'released' ? at(releasedDays, 17) : null });
  if (status === 'released')
    add('wallet_transactions', { id: sid('wtx:job:' + key), user_id: quoteRow.artisan_id, direction: 'credit', amount_kobo: quoteRow.amount_kobo - fee, kind: 'escrow_release', description: `Job payment – ${jb.title}`, reference: `seed:escrow:job:${key}`, created_at: at(releasedDays, 17) });
}

// J1 completed plumbing job (tenant-requested)
job('shower', { property_id: P.harmonyCourt.id, landlord_id: U.olapade, tenant_id: U.isreal, maintenance_request_id: M.isrealShower.id, title: 'Fix low shower pressure & dripping mixer', category: 'Plumbing',
  description: M.isrealShower.description, budget_min_kobo: N(25_000), budget_max_kobo: N(80_000), access_notes: 'Flat 1A. Tenant is home after 4pm on weekdays.', status: 'completed',
  artisan_id: U.musa, started_at: at(-23, 10), completed_at: at(-20, 15), created_at: at(-26, 10) });
const qShower = quote('shower:musa', 'shower', U.musa, N(55_000), 'accepted', [{ item: 'Mixer tap cartridge', amount: N(18_000) }, { item: 'Shower head & hose', amount: N(12_000) }, { item: 'Labour', amount: N(25_000) }], '1 day', 'Will also flush the line to clear sediment.', -25);
quote('shower:emeka', 'shower', U.emeka, N(70_000), 'declined', [{ item: 'Materials', amount: N(35_000) }, { item: 'Labour', amount: N(35_000) }], '2 days', null, -25);
J.shower.accepted_quote_id = qShower.id;
jobEscrow('shower', 'shower', qShower, 'released', -19);
['before', 'after'].forEach((kind, i) => add('job_media', { id: sid(`jm:shower:${kind}`), job_id: J.shower.id, kind, url: img(i ? '1620626011761-996317b8d101' : '1584622650111-993a426fbf0a') }));
add('job_reports', { id: sid('jr:shower'), job_id: J.shower.id, artisan_id: U.musa, diagnosis: 'Mixer cartridge worn out and shower head clogged with limescale. Line had sediment from the overhead tank.',
  materials: [{ qty: 1, item: 'Mixer tap cartridge', costKobo: N(18_000) }, { qty: 1, item: 'Shower head & hose', costKobo: N(12_000) }], labor_kobo: N(25_000), total_kobo: N(55_000),
  est_completion: at(-21, 17), exceeds_quote: false, status: 'approved', created_at: at(-23, 13) });
add('job_reviews', { id: sid('jrev:shower:olapade'), job_id: J.shower.id, reviewer_id: U.olapade, reviewee_id: U.musa, rating: 5, comment: 'Quick diagnosis and very tidy work. Will use again for the other flats.', reply: 'Thank you sir, always available.', replied_at: at(-18), created_at: at(-19, 18) });
add('job_reviews', { id: sid('jrev:shower:isreal'), job_id: J.shower.id, reviewer_id: U.isreal, reviewee_id: U.musa, rating: 4, comment: 'Pressure is great now. Came a bit late on day one but called ahead.', created_at: at(-19, 20) });

// J2 open emergency electrical job (tenant-requested) – visible to electricians
job('socket', { property_id: P.harmonyCourt.id, landlord_id: U.olapade, tenant_id: U.isreal, maintenance_request_id: M.isrealSocket.id, title: 'Sparking kitchen socket – urgent', category: 'Electrical',
  description: M.isrealSocket.description, urgency: 'urgent', budget_min_kobo: N(15_000), budget_max_kobo: N(50_000), access_notes: 'Breaker for the kitchen has been switched off. Call tenant on arrival.', status: 'open', created_at: at(-1, 11) });
quote('socket:emeka', 'socket', U.emeka, N(32_000), 'pending', [{ item: '13A double socket & back box', amount: N(7_000) }, { item: '2.5mm cable (5m)', amount: N(5_000) }, { item: 'Labour', amount: N(20_000) }], 'Same day', 'Can come today by 5pm.', -0.5);
add('job_media', { id: sid('jm:socket:issue'), job_id: J.socket.id, kind: 'issue', url: img('1621905252507-b35492cc74b4') });
add('job_declines', { job_id: J.socket.id, artisan_id: U.musa });

// J3 tenant-requested, artisan's estimate is waiting for landlord approval
job('ceiling', { property_id: P.ajahTerrace.id, landlord_id: U.akindola, tenant_id: U.tunde, maintenance_request_id: M.tundeCeiling.id, title: 'Trace roof-tank leak and repaint bathroom ceiling', category: 'Plumbing',
  description: M.tundeCeiling.description, urgency: 'urgent', budget_min_kobo: N(60_000), budget_max_kobo: N(150_000), access_notes: 'Ladder access to the roof tank is through the upstairs balcony.', status: 'awaiting_approval',
  artisan_id: U.musa, started_at: at(-6, 10), created_at: at(-7, 10) });
const qCeiling = quote('ceiling:musa', 'ceiling', U.musa, N(120_000), 'accepted', [{ item: 'Leak tracing', amount: N(30_000) }, { item: 'Ceiling board & paint', amount: N(50_000) }, { item: 'Labour', amount: N(40_000) }], '3 days', 'Price may change once I open the ceiling.', -7);
J.ceiling.accepted_quote_id = qCeiling.id;
jobEscrow('ceiling', 'ceiling', qCeiling, 'held');
add('job_media', { id: sid('jm:ceiling:before'), job_id: J.ceiling.id, kind: 'before', url: img('1585128792020-803d29415281') });
add('job_reports', { id: sid('jr:ceiling'), job_id: J.ceiling.id, artisan_id: U.musa, diagnosis: 'Overflow pipe on the roof tank is cracked and the tank lid is missing, so rain and overflow soak the ceiling. Two ceiling boards are rotten.',
  materials: [{ qty: 1, item: 'Overflow pipe & fittings', costKobo: N(25_000) }, { qty: 1, item: 'Tank lid', costKobo: N(15_000) }, { qty: 2, item: 'PVC ceiling boards', costKobo: N(40_000) }, { qty: 1, item: 'Emulsion paint (4L)', costKobo: N(25_000) }],
  labor_kobo: N(80_000), total_kobo: N(185_000), est_completion: at(2, 17), exceeds_quote: true, status: 'pending', created_at: at(-4, 15) });

// J4 landlord's own job, in progress
job('lights', { property_id: P.ikoyiDuplex.id, landlord_id: U.adebayo, title: 'Install outdoor security lights', category: 'Electrical', description: 'Install 6 motion-sensor flood lights around the compound and connect them to the inverter.',
  budget_min_kobo: N(150_000), budget_max_kobo: N(300_000), access_notes: 'Property is vacant. Gatekeeper (Sunday) has the keys.', status: 'in_progress', artisan_id: U.emeka, started_at: at(-2, 9), created_at: at(-6, 9) });
const qLights = quote('lights:emeka', 'lights', U.emeka, N(240_000), 'accepted', [{ item: '6 × 50W LED motion flood lights', amount: N(150_000) }, { item: 'Cabling & conduits', amount: N(30_000) }, { item: 'Labour', amount: N(60_000) }], '2 days', null, -5);
quote('lights:musa', 'lights', U.musa, N(280_000), 'declined', [{ item: 'Materials & labour', amount: N(280_000) }], '3 days', null, -5);
J.lights.accepted_quote_id = qLights.id;
jobEscrow('lights', 'lights', qLights, 'held');

// J5 open general job with a pending quote
job('fumigation', { property_id: P.palmGrove.id, landlord_id: U.oyakilome, title: 'Fumigate all three units and the compound', category: 'General Repair', description: 'Quarterly fumigation for cockroaches and mosquitoes. Units must be done on a Saturday.',
  budget_min_kobo: N(60_000), budget_max_kobo: N(120_000), status: 'open', created_at: at(-3, 13) });
quote('fumigation:musa', 'fumigation', U.musa, N(95_000), 'pending', [{ item: 'Chemicals', amount: N(45_000) }, { item: 'Labour (2 people)', amount: N(50_000) }], 'Saturday', 'Tenants need to be out for 3 hours.', -2);

// J6 completed electrical job with a revised (higher) final amount the landlord approved
job('generator', { property_id: P.ajahTerrace.id, landlord_id: U.akindola, title: 'Generator servicing & changeover repair', category: 'Electrical', description: 'Service the 10kVA generator and fix the changeover switch that keeps tripping.',
  budget_min_kobo: N(40_000), budget_max_kobo: N(100_000), status: 'completed', artisan_id: U.emeka, started_at: at(-60, 10), completed_at: at(-59, 16), created_at: at(-63, 10),
  revised_amount_kobo: N(95_000), revision_status: 'approved', revision_note: 'Changeover contacts were burnt and had to be replaced.' });
const qGen = quote('generator:emeka', 'generator', U.emeka, N(80_000), 'accepted', [{ item: 'Service kit (oil, filters, plugs)', amount: N(35_000) }, { item: 'Labour', amount: N(45_000) }], '1 day', null, -62);
J.generator.accepted_quote_id = qGen.id;
jobEscrow('generator', 'generator', qGen, 'released', -58);
payment('job:generator:topup', { user_id: U.akindola, purpose: 'job_topup', amount_kobo: N(15_000), job_id: J.generator.id, paid_at: at(-59, 15), created_at: at(-59, 15) });
add('job_reviews', { id: sid('jrev:generator:akindola'), job_id: J.generator.id, reviewer_id: U.akindola, reviewee_id: U.emeka, rating: 4, comment: 'Good job, explained the extra cost clearly before buying parts.', created_at: at(-58, 12) });

// J7 cancelled
job('borehole', { property_id: P.magodoBungalow.id, landlord_id: U.olapade, title: 'Replace borehole pump', category: 'Plumbing', description: 'Submersible pump stopped working. Need replacement with a 1.5HP pump.',
  budget_min_kobo: N(180_000), budget_max_kobo: N(350_000), status: 'cancelled', created_at: at(-35, 9) });
add('job_declines', { job_id: J.borehole.id, artisan_id: U.emeka });

// ───────── chat, calls ─────────
const C = {};
function convo(key, type, contextId, a, b, msgs, createdDays) {
  C[key] = add('conversations', { id: sid('conv:' + key), context_type: type, context_id: contextId, participant_a: a, participant_b: b, created_at: at(createdDays, 9) });
  let prev = null;
  msgs.forEach(([from, body, mins, extra], i) => {
    const created = new Date(Date.parse(at(createdDays, 9)) + mins * 60000).toISOString();
    const unread = i === msgs.length - 1 && i > 0 && createdDays >= -3; // last message of recent chats stays unread
    const m = add('messages', { id: sid(`msg:${key}:${i}`), conversation_id: C[key].id, sender_id: from === 'a' ? a : b, body, read_at: unread ? null : new Date(Date.parse(created) + 600000).toISOString(),
      created_at: created, reply_to_id: extra?.reply && prev ? prev : null, attachment_url: null, ...(extra?.file ?? {}) });
    prev = m.id;
  });
  return C[key];
}
convo('isrealVi', 'booking', B.isrealVi.id, U.isreal, U.chinedu, [
  ['a', 'Good afternoon, I just booked an inspection for the VI studio. Is the time okay?', 0], ['b', 'Good afternoon Isreal, yes that works. I will meet you at the gate.', 12],
  ['a', 'Is the power really 24 hours?', 30], ['b', 'Yes – there is a central inverter plus generator. I will show you the power room.', 41, { reply: true }],
  ['a', 'Thanks, see you then 👍', 50]], -33);
convo('isrealOffice', 'booking', B.isrealOffice.id, U.isreal, U.chinedu, [
  ['a', 'Hello, booking the office for my startup – about 15 people. Can we view on the day?', 0], ['b', 'Confirmed. Bring your company documents if you want to start the paperwork.', 25],
  ['b', 'Here is the floor plan.', 26, { file: { attachment_path: `chat/${sid('conv:isrealOffice')}/floor-plan.pdf`, attachment_name: 'Admiralty-Way-2F-floor-plan.pdf', attachment_type: 'application/pdf', attachment_size: 384201 } }],
  ['a', 'Perfect, thank you!', 70]], -2);
convo('amaraIkoyi', 'booking', B.amaraIkoyi.id, U.amara, U.adebayo, [
  ['a', 'Good morning sir, can I come with my husband for the inspection?', 0], ['b', 'Of course, you are both welcome.', 20],
  ['a', 'We loved the house. Is the rent negotiable?', 2000], ['b', 'Slightly, for a 2-year payment. Let us talk after you decide.', 2100]], -17);
convo('tundeHarmony', 'booking', B.tundeHarmony.id, U.tunde, U.olapade, [
  ['a', 'Hi, I am on my way to Harmony Court, about 15 minutes away.', 0], ['b', 'Alright, the caretaker Mr. Femi will let you in.', 5], ['a', 'Thanks for the visit. I noticed the water pressure upstairs is low.', 300], ['b', 'Noted, we are fixing it this week.', 340]], -38);
convo('dolapoPalm', 'booking', B.dolapoPalm.id, U.dolapoT, U.oyakilome, [
  ['a', 'Hello, I would like to see the 1 bedroom flat at Palm Grove.', 0], ['b', 'Sure. Inspection is confirmed – come with a valid ID please.', 18], ['a', 'Is the parking space shared?', 40]], -1);
convo('anonVi', 'booking', B.anonVi.id, U.anon, U.chinedu, [['a', 'Hi, is the studio still available for December?', 0], ['b', 'Yes it is. See you on the inspection day.', 15]], -1);
convo('shower:landlord', 'job', J.shower.id, U.olapade, U.musa, [
  ['a', 'Musa, your quote is accepted. Please go to Flat 1A after 4pm.', 0], ['b', 'Okay sir, I will be there on Friday.', 15],
  ['b', 'Done. Cartridge and shower head replaced, line flushed.', 4500], ['a', 'Great work, I have confirmed completion.', 4800]], -24);
convo('ceiling:landlord', 'job', J.ceiling.id, U.akindola, U.musa, [
  ['b', 'Sir, I have opened the ceiling. The overflow pipe on the tank is cracked and two boards are rotten. I have sent the new estimate.', 0],
  ['a', 'That is more than the quote. Can you send photos of the boards?', 60], ['b', 'Sending now.', 75, { file: { attachment_path: `chat/${sid('conv:ceiling:landlord')}/rotten-boards.jpg`, attachment_name: 'rotten-boards.jpg', attachment_type: 'image/jpeg', attachment_size: 512334 } }]], -4);
convo('lights', 'job', J.lights.id, U.adebayo, U.emeka, [['a', 'Sunday the gateman will open for you at 9am.', 0], ['b', 'Noted sir. 4 of 6 lights are up, finishing the rest tomorrow.', 1500]], -3);
convo('generator', 'job', J.generator.id, U.akindola, U.emeka, [['b', 'The changeover contacts are burnt. Replacement is ₦15,000 extra.', 0], ['a', 'Go ahead, I will approve the revised amount.', 20]], -60);

function call(key, convKey, caller, callee, kind, status, startDays, secs) {
  const created = at(startDays, 19);
  add('calls', { id: sid('call:' + key), conversation_id: C[convKey].id, caller_id: caller, callee_id: callee, kind, status, offer: null, answer: null,
    end_reason: status === 'ended' ? 'hangup' : status === 'missed' ? 'no_answer' : status === 'declined' ? 'declined' : null,
    created_at: created, answered_at: status === 'ended' ? new Date(Date.parse(created) + 8000).toISOString() : null,
    ended_at: new Date(Date.parse(created) + (secs + 8) * 1000).toISOString() });
}
call('isrealOffice', 'isrealOffice', U.isreal, U.chinedu, 'audio', 'ended', -1, 245);
call('isrealOfficeMissed', 'isrealOffice', U.chinedu, U.isreal, 'audio', 'missed', -2, 30);
call('lights', 'lights', U.emeka, U.adebayo, 'video', 'ended', -1, 410);
call('ceiling', 'ceiling:landlord', U.akindola, U.musa, 'audio', 'declined', -3, 6);
call('dolapoPalm', 'dolapoPalm', U.dolapoT, U.oyakilome, 'audio', 'missed', 0, 25);

// ───────── subscriptions (agent) ─────────
const plans = (await db.from('subscription_plans').select('id, name, price_kobo')).data ?? [];
const planBy = (n) => plans.find((p) => p.name === n);
if (planBy('Starter') && planBy('Elite')) {
  const old = add('subscriptions', { id: sid('sub:chinedu:starter'), agent_id: U.chinedu, plan_id: planBy('Starter').id, status: 'expired', billing_cycle: 'monthly', starts_at: at(-100), expires_at: at(-70), created_at: at(-100) });
  payment('sub:chinedu:starter', { user_id: U.chinedu, purpose: 'subscription', amount_kobo: planBy('Starter').price_kobo, subscription_id: old.id, paid_at: at(-100), created_at: at(-100) });
  const quit = add('subscriptions', { id: sid('sub:chinedu:elite'), agent_id: U.chinedu, plan_id: planBy('Elite').id, status: 'cancelled', billing_cycle: 'yearly', starts_at: null, expires_at: null, created_at: at(-9) });
  payment('sub:chinedu:elite', { user_id: U.chinedu, purpose: 'subscription', amount_kobo: Math.round(planBy('Elite').price_kobo * 12 * 0.8), subscription_id: quit.id, status: 'failed', paid_at: null, created_at: at(-9) });
}

// ───────── wallets: withdrawals, adjustments, bank accounts ─────────
const banks = [[U.adebayo, '058', 'GTBank', '0123456781', 'ADEBAYO OKAFOR'], [U.olapade, '044', 'Access Bank', '0234567812', 'OLAPADE DOE'], [U.oyakilome, '057', 'Zenith Bank', '2034567813', 'OYAKILOME OLAWALE'],
  [U.akindola, '033', 'UBA', '2145678914', 'AKINDOLA OLAWALE'], [U.chinedu, '011', 'First Bank', '3056789015', 'CHINEDU OKORO'], [U.musa, '999992', 'OPay', '8031234516', 'MUSA IBRAHIM'], [U.emeka, '50515', 'Moniepoint', '6012345617', 'EMEKA NWOSU']];
banks.forEach(([u, code, name, acct, holder]) => add('bank_accounts', { user_id: u, bank_code: code, bank_name: name, account_number: acct, account_name: holder, paystack_recipient_code: `RCP_SEED_${u.slice(0, 8)}`, created_at: at(-90) }));
function withdrawal(key, user, amount, status, days) {
  add('withdrawals', { id: sid('wd:' + key), user_id: user, amount_kobo: amount, reference: `RC-SEED-WD-${key.toUpperCase()}`, status, created_at: at(days, 12) });
  if (status !== 'failed') add('wallet_transactions', { id: sid('wtx:wd:' + key), user_id: user, direction: 'debit', amount_kobo: amount, kind: 'withdrawal', description: 'Withdrawal to bank', reference: `seed:wd:${key}`, created_at: at(days, 12) });
  if (status === 'reversed') add('wallet_transactions', { id: sid('wtx:wdr:' + key), user_id: user, direction: 'credit', amount_kobo: amount, kind: 'withdrawal_reversal', description: 'Withdrawal reversed by bank', reference: `seed:wdr:${key}`, created_at: at(days + 1, 9) });
}
withdrawal('olapade1', U.olapade, N(1_500_000), 'success', -200);
withdrawal('akindola1', U.akindola, N(1_000_000), 'success', -80);
withdrawal('akindola2', U.akindola, N(200_000), 'pending', -1);
withdrawal('musa1', U.musa, N(40_000), 'success', -17);
withdrawal('musa2', U.musa, N(10_000), 'failed', -10);
withdrawal('emeka1', U.emeka, N(50_000), 'reversed', -55);
withdrawal('chinedu1', U.chinedu, N(8_000), 'success', -25);
add('wallet_transactions', { id: sid('wtx:adj:emeka'), user_id: U.emeka, direction: 'credit', amount_kobo: N(5_000), kind: 'adjustment', description: 'Goodwill credit for delayed payout', reference: 'seed:adj:emeka', created_at: at(-50) });

// ───────── identity checks (history only – nobody's verified status changes) ─────────
const vf = (key, user, last3, status, reason, days, extra = {}) => add('verifications', { id: sid('vf:' + key), user_id: user, nin_hash: createHash('sha256').update('seed-nin:' + key).digest('hex'), nin_last3: last3,
  status, confidence: status === 'failed' ? 0.41 : 0.78, failure_reason: reason, metadata: { seed: true }, counts_as_attempt: false, document_type: 'nin_slip', created_at: at(days), ...extra });
vf('emeka:1', U.emeka, '318', 'failed', 'Selfie too dark to match the NIN photo', -30, { reviewed_by: U.funmi, reviewed_at: at(-29), review_note: 'Asked user to retake in daylight.' });
vf('tunde:1', U.tunde, '552', 'failed', 'Face did not match closely enough', -95);

// ───────── artisans ─────────
add('artisan_profiles', { user_id: U.dolapoA, skill_category: 'Carpentry', additional_skills: ['Furniture repair', 'Door & window fitting', 'Kitchen cabinets', 'Wardrobes'], service_areas: ['Yaba', 'Surulere', 'Gbagada', 'Ikeja'],
  years_experience: 5, state: 'Lagos', lga: 'Lagos Mainland', home_address: 'Alagomeji, Yaba, Lagos', bio: 'Carpenter specialising in fitted wardrobes, kitchen cabinets and door repairs. Neat finishing, fair prices.',
  available: true, availability_hours: 'Mon–Sat, 8am – 5pm', review_status: 'pending', terms_accepted_at: '2026-11-18T09:00:00Z', submitted_at: '2026-11-18T09:05:00Z' });
add('artisan_documents', { id: sid('adoc:dolapo:id'), user_id: U.dolapoA, doc_type: 'gov_id', storage_path: `artisan-docs/${U.dolapoA}/drivers-licence.jpg`, original_name: 'drivers-licence.jpg', created_at: at(-1) });
add('artisan_documents', { id: sid('adoc:dolapo:cert'), user_id: U.dolapoA, doc_type: 'trade_certificate', storage_path: `artisan-docs/${U.dolapoA}/nabteb-carpentry.pdf`, original_name: 'NABTEB carpentry certificate.pdf', created_at: at(-1) });
add('artisan_documents', { id: sid('adoc:musa:cert'), user_id: U.musa, doc_type: 'trade_certificate', storage_path: `artisan-docs/${U.musa}/plumbing-cert.pdf`, original_name: 'Plumbing trade test.pdf', created_at: at(-100) });
[[U.dolapoA, '1595428774223-ef52624120d2', 'Fitted wardrobe, Surulere'], [U.dolapoA, '1556911220-bff31c812dba', 'Kitchen cabinets, Gbagada'], [U.dolapoA, '1581539250439-c96689b516dd', 'Restored dining set'],
  [U.musa, '1620626011761-996317b8d101', 'Shower replacement, Gbagada'], [U.emeka, '1558002038-1055907df827', 'Distribution board upgrade']].forEach(([u, ph, caption], i) =>
  add('artisan_portfolio', { id: sid('port:' + i), user_id: u, url: img(ph), caption, created_at: at(-30 + i) }));
[[U.dolapoA, 'Mr. Segun Afolabi', '+2348000000301', 'client', 'Fitted all wardrobes in my 4 bedroom house', null, null, 2],
  [U.dolapoA, 'Engr. Ngozi Umeh', '+2348000000302', 'employer', 'Worked with our fit-out team for 3 years', 'Umeh Interiors Ltd', 'Project Manager', 4],
  [U.musa, 'Mrs. Yetunde Bello', '+2348000000303', 'landlord', 'Maintains plumbing across my 3 properties', null, null, 6],
  [U.emeka, 'Mr. Ibrahim Sani', '+2348000000304', 'colleague', 'Trained together at the Ikeja tech centre', 'Sani Electricals', 'Owner', 8]].forEach(([u, name, phone, relationship, note, company, job_title, years_known], i) =>
  add('artisan_references', { id: sid('ref:' + i), user_id: u, name, phone, email: null, relationship, company, job_title, years_known, note, consent: true, socials: [], created_at: at(-60) }));

// ───────── documents, support, feedback ─────────
[[U.isreal, T.isrealHarmony.id, 'lease', 'Harmony Court tenancy agreement', 'application/pdf', 612003, true],
  [U.isreal, T.isrealHarmony.id, 'receipt', 'Rent receipt – March 2026', 'application/pdf', 88120, true],
  [U.anon, T.anonPalm.id, 'id', 'National ID card', 'image/jpeg', 402331, false],
  [U.tunde, T.tundeAjah.id, 'utility', 'Ikeja Electric bill – October', 'application/pdf', 120554, true],
  [U.dolapoT, T.dolapoYaba.id, 'letter', 'Guarantor letter', 'application/pdf', 75342, true],
  [U.amara, null, 'other', 'Employment letter', 'application/pdf', 99876, false]].forEach(([u, ten, category, title, mime, size, shared], i) =>
  add('user_documents', { id: sid('udoc:' + i), user_id: u, tenancy_id: ten, category, title, storage_path: `user-docs/${u}/${sid('udoc:' + i)}${mime === 'image/jpeg' ? '.jpg' : '.pdf'}`, mime_type: mime, size_bytes: size, shared_with_landlord: shared, created_at: at(-50 + i * 7) }));

[[U.isreal, 'support', 'payments', 'RentSave top-up not showing', 'I paid ₦220,000 into RentSave by transfer last month and it took two days to reflect.', null, 'resolved', 'Bank delay – confirmed the top-up reflected. Closed.', -19],
  [U.anon, 'bug', 'app', 'App freezes when uploading AC photo', 'When I add a photo to my maintenance request the app freezes for about 10 seconds.', 'medium', 'open', null, -2],
  [U.olapade, 'support', 'listings', 'How do I add a fifth unit to Harmony Court?', 'We converted the ground-floor store to a studio. How do I add it?', null, 'in_progress', 'Sent guide for Manage Units.', -5],
  [U.musa, 'support', 'payouts', 'Withdrawal failed', 'My ₦10,000 withdrawal to OPay failed. Please check.', null, 'open', null, -10],
  [U.tunde, 'data_request', 'privacy', 'Download my data', 'Please send me a copy of my account data.', null, 'closed', 'Export sent to user email.', -70],
  [U.chinedu, 'bug', 'app', 'Listing views chart shows zero', 'Performance chart on my VI studio shows 0 views for yesterday.', 'low', 'resolved', 'Fixed in the 1.0.3 update.', -12]].forEach(([u, kind, category, subject, message, severity, status, note, d], i) =>
  add('support_tickets', { id: sid('ticket:' + i), user_id: u, kind, category, subject, message, severity, status, admin_note: note,
    meta: kind === 'bug' ? { platform: i % 2 ? 'ios' : 'android', appVersion: '1.0.2', device: i % 2 ? 'iPhone 13' : 'Tecno Camon 20' } : {}, created_at: at(d), updated_at: at(d + 1) }));

[[U.isreal, 5, ['Easy to use', 'RentSave'], 'Saving for rent bit by bit has really helped me.'], [U.amara, 4, ['Good listings'], 'Would love more listings in Yaba.'],
  [U.olapade, 5, ['Rent tracking', 'Maintenance'], 'Managing my four flats is so much easier now.'], [U.musa, 4, ['Fast payouts'], null], [U.tunde, 3, ['Slow support'], 'Report took a long time to be reviewed.'],
  [U.chinedu, 4, ['Good listings', 'Easy to use'], 'Please add a featured listing option.']].forEach(([u, rating, tags, comment], i) =>
  add('app_feedback', { id: sid('fb:' + i), user_id: u, rating, tags, comment, platform: i % 2 ? 'ios' : 'android', app_version: '1.0.2', created_at: at(-15 + i) }));

// ───────── admin: audit trail, notes, announcement ─────────
[['listing_approved', 'property', P.ikoyiDuplex.id, { title: P.ikoyiDuplex.title }, -59], ['listing_rejected', 'property', P.ikejaGra.id, { reason: P.ikejaGra.rejection_reason }, -19],
  ['report_status', 'report', sid('report:tundeVi'), { status: 'investigating' }, -18], ['verification_reviewed', 'verification', sid('vf:emeka:1'), { decision: 'failed' }, -29],
  ['support_reply', 'support_ticket', sid('ticket:0'), { status: 'resolved' }, -18], ['withdrawal_reversed', 'withdrawal', sid('wd:emeka1'), {}, -54]].forEach(([action, target_type, target_id, details, d], i) =>
  add('admin_actions', { id: sid('aa:' + i), admin_id: U.funmi, action, target_type, target_id, details, created_at: at(d) }));
add('admin_notes', { id: sid('an:magodo'), target_type: 'property', target_id: P.magodoBungalow.id, admin_id: U.funmi, body: 'Price looks high for Magodo – called the manager, they confirmed it includes service charge. OK to approve after photo check.', created_at: at(0, 8) });
add('admin_notes', { id: sid('an:report'), target_type: 'report', target_id: sid('report:tundeVi'), admin_id: U.funmi, body: 'Agent has 2 previous late cancellations. Warn if no proof by Friday.', created_at: at(-18) });
add('admin_notes', { id: sid('an:chinedu'), target_type: 'user', target_id: U.chinedu, admin_id: U.funmi, body: 'Top agent by views this month. Candidate for the featured agent pilot.', created_at: at(-5) });
add('announcements', { id: sid('ann:holiday'), admin_id: U.funmi, title: 'Holiday support hours', body: 'Our support team will be available 9am – 3pm from 24 Dec to 1 Jan. Payments and escrow keep working as normal.', audience: { roles: ['tenant', 'landlord', 'estate_manager', 'agent', 'artisan'] }, recipients: 13, created_at: at(-2) });
add('announcements', { id: sid('ann:artisans'), admin_id: U.funmi, title: 'New: faster artisan payouts', body: 'Job payments are now released to your wallet within 2 hours of the landlord confirming completion.', audience: { roles: ['artisan'] }, recipients: 3, created_at: at(-21) });

// ───────── notifications (each links to the row it is about) ─────────
let ni = 0;
const notify = (user, type, title, body, data, days, read = true) =>
  add('notifications', { id: sid('notif:' + ni++), user_id: user, type, title, body, data, read_at: read ? at(days, 20) : null, created_at: at(days, 9 + (ni % 9), (ni * 7) % 60) });
// tenants
notify(U.isreal, 'booking_confirmed', 'Inspection confirmed', 'Your inspection of Open-Plan Office Space on Admiralty Way is confirmed.', { bookingId: B.isrealOffice.id }, -1, false);
notify(U.isreal, 'message', 'New message from Chinedu', 'Here is the floor plan.', { conversationId: C.isrealOffice.id }, -1, false);
notify(U.isreal, 'lease_renewal', 'Lease renewal offer', 'Olapade sent a renewal for Flat 1A until Feb 2028 at ₦2,640,000/year.', { tenancyId: T.isrealHarmony.id }, -3, false);
notify(U.isreal, 'maintenance_update', 'Job posted for your request', 'An electrician will be assigned to the sparking socket soon.', { requestId: M.isrealSocket.id }, -1);
notify(U.isreal, 'rentsave', 'RentSave top-up received', '₦220,000 added to Harmony Court 2027 Rent.', { planId: PLAN.isreal.id }, -20);
notify(U.isreal, 'missed_call', 'Missed call from Chinedu', 'Chinedu Okoro tried to call you.', { conversationId: C.isrealOffice.id }, -2);
notify(U.isreal, 'review_reply', 'Chinedu replied to your review', 'Thank you Isreal! Glad you liked it…', { reviewId: R.isrealVi.id }, -28);
notify(U.amara, 'refund', 'Refund processed', 'Your inspection fee for the Ibeju-Lekki land has been refunded.', { bookingId: B.amaraLand.id }, -9);
notify(U.amara, 'inspection_done', 'How was your inspection?', 'Leave a review for 4 Bedroom Semi-Detached Duplex.', { bookingId: B.amaraIkoyi.id }, -14);
notify(U.amara, 'rentsave', 'Weekly savings on track', 'You have saved ₦360,000 towards Next Apartment Fund.', { planId: PLAN.amara.id }, -2, false);
notify(U.tunde, 'booking_cancelled', 'Inspection declined', 'The agent declined your inspection of Furnished Studio, Victoria Island. You have been refunded.', { bookingId: B.tundeVi.id }, -20);
notify(U.tunde, 'report_update', 'Your report is being investigated', 'Our team is looking into your report.', {}, -18);
notify(U.tunde, 'rent_reminder', 'Rent overdue', 'Your quarterly rent of ₦1,375,000 for Unit 4 was due on 1 Nov.', { tenancyId: T.tundeAjah.id }, -6, false);
notify(U.tunde, 'maintenance_update', 'Repair estimate submitted', 'The artisan found a cracked overflow pipe. Waiting for landlord approval.', { requestId: M.tundeCeiling.id }, -4, false);
notify(U.anon, 'rent_reminder', 'Rent overdue', 'Your November rent of ₦120,000 for Studio G1 is overdue.', { tenancyId: T.anonPalm.id }, -4, false);
notify(U.anon, 'booking_request', 'Booking received', 'Waiting for the landlord to confirm your inspection of the Ikoyi duplex.', { bookingId: B.anonIkoyi.id }, -1, false);
notify(U.anon, 'tenancy_added', 'You were added to a tenancy', 'Studio G1, Palm Grove Residences.', { tenancyId: T.anonPalm.id }, -172);
notify(U.dolapoT, 'booking_confirmed', 'Inspection confirmed', 'Palm Grove Residences – bring a valid ID.', { bookingId: B.dolapoPalm.id }, -1);
notify(U.dolapoT, 'missed_call', 'You missed a call… ', 'Call to Oyakilome Olawale was not answered.', { conversationId: C.dolapoPalm.id }, 0, false);
notify(U.dolapoT, 'maintenance_update', 'Request declined', 'Your door lock request was declined. See the reason in the ticket.', { requestId: M.dolapoLock.id }, -15);
notify(U.dolapoT, 'rentsave', 'Goal reached 🎉', 'Yaba Rent 2027 is fully funded.', { planId: PLAN.dolapo.id }, -60);
// managers / agent
notify(U.olapade, 'maintenance_request', 'Urgent maintenance request', 'Flat 1A: sparking kitchen socket.', { requestId: M.isrealSocket.id }, -1, false);
notify(U.olapade, 'listing_review', 'Listing under review', '3 Bedroom Bungalow with Large Compound is being checked by our team.', { propertyId: P.magodoBungalow.id }, -1, false);
notify(U.olapade, 'rent_paid', 'Rent received', 'Kemi Adeyemi – Flat 2A (recorded bank transfer).', { tenancyId: T.inviteHarmony.id }, -10);
notify(U.olapade, 'new_review', 'New review', 'Tunde rated Harmony Court 3★.', { reviewId: R.tundeHarmony.id }, -37);
notify(U.olapade, 'withdrawal_update', 'Withdrawal successful', '₦1,500,000 sent to Access Bank ••••7812.', {}, -200);
notify(U.oyakilome, 'maintenance_request', 'New maintenance request', 'Studio G1: AC not cooling.', { requestId: M.anonAc.id }, -2, false);
notify(U.oyakilome, 'new_quote', 'New quote received', 'Musa Ibrahim quoted ₦95,000 for fumigation.', { jobId: J.fumigation.id }, -2, false);
notify(U.oyakilome, 'booking_confirmed', 'Inspection booked', 'Dolapo booked an inspection at Palm Grove Residences.', { bookingId: B.dolapoPalm.id }, -1);
notify(U.oyakilome, 'missed_call', 'Missed call', 'Dolapo Oluwole tried to call you.', { conversationId: C.dolapoPalm.id }, 0, false);
notify(U.akindola, 'report_submitted', 'Repair estimate needs approval', 'Musa Ibrahim: ₦185,000 (₦65,000 above the quote).', { jobId: J.ceiling.id }, -4, false);
notify(U.akindola, 'maintenance_escalated', 'Maintenance escalated', 'Unit 4 ceiling leak passed its SLA.', { requestId: M.tundeCeiling.id }, -8);
notify(U.akindola, 'listing_approved', 'Listing rejected', '2 Bedroom Flat, Ikeja GRA needs new photos.', { propertyId: P.ikejaGra.id }, -19);
notify(U.akindola, 'withdrawal_update', 'Withdrawal processing', '₦200,000 to UBA is on its way.', {}, -1, false);
notify(U.adebayo, 'job_started', 'Work started', 'Emeka started installing the security lights.', { jobId: J.lights.id }, -2);
notify(U.adebayo, 'booking_request', 'New inspection request', 'A tenant booked the Ikoyi duplex for next week.', { bookingId: B.anonIkoyi.id }, -1, false);
notify(U.adebayo, 'lease_renewal', 'Renewal accepted', 'Dolapo accepted the renewal for Room 3 until Jan 2028.', { tenancyId: T.dolapoYaba.id }, -12);
notify(U.chinedu, 'booking_request', 'New inspection request', 'Furnished Studio, Victoria Island – in 3 days.', { bookingId: B.anonVi.id }, -1, false);
notify(U.chinedu, 'new_review', 'New 5★ review', 'Isreal reviewed Furnished Studio, Victoria Island.', { reviewId: R.isrealVi.id }, -29);
notify(U.chinedu, 'payment_released', 'Inspection fee released', '₦9,000 added to your wallet.', {}, -30);
notify(U.chinedu, 'subscription_expired', 'Subscription expired', 'Your Starter plan expired. Renew to keep listings visible.', {}, -70);
// artisans
notify(U.musa, 'quote_accepted', 'Quote accepted', 'Your ₦120,000 quote for the Ajah ceiling leak was accepted.', { jobId: J.ceiling.id }, -7);
notify(U.musa, 'payment_released', 'Payment released', '₦49,500 for the shower repair is in your wallet.', {}, -19);
notify(U.musa, 'new_review', 'New 5★ review', 'Olapade: "Quick diagnosis and very tidy work."', { reviewId: sid('jrev:shower:olapade') }, -19);
notify(U.musa, 'withdrawal_update', 'Withdrawal failed', '₦10,000 to OPay failed and has not been deducted.', {}, -10, false);
notify(U.emeka, 'job_alert', 'Urgent electrical job near you', 'Sparking kitchen socket – Gbagada. Budget ₦15k–₦50k.', { jobId: J.socket.id }, -1, false);
notify(U.emeka, 'quote_accepted', 'Quote accepted', 'Install outdoor security lights – ₦240,000.', { jobId: J.lights.id }, -5);
notify(U.emeka, 'revision_approved', 'Revised amount approved', 'Akindola approved ₦95,000 for the generator job.', { jobId: J.generator.id }, -59);
notify(U.emeka, 'verification_failed', 'ID check unsuccessful', 'Your selfie was too dark. Please try again in daylight.', {}, -29);
notify(U.dolapoA, 'announcement', 'Application received', 'Thanks for applying as an artisan. Our team will review your documents within 48 hours.', {}, -1, false);
notify(U.dolapoA, 'job_alert', 'Carpentry jobs are coming', 'Once approved you will get job alerts for Yaba, Surulere, Gbagada and Ikeja.', {}, 0, false);
// admin + everyone: announcement
[...TENANTS, U.adebayo, U.olapade, U.oyakilome, U.akindola, U.chinedu, U.musa, U.emeka, U.dolapoA].forEach((u) => notify(u, 'announcement', 'Holiday support hours', 'Support is available 9am – 3pm from 24 Dec to 1 Jan.', {}, -2, false));
notify(U.funmi, 'admin_message', 'Listing needs review', '3 Bedroom Bungalow with Large Compound – AI flagged the price.', { propertyId: P.magodoBungalow.id }, -1, false);
notify(U.funmi, 'admin_message', 'New artisan application', 'Dolapo Oluwole (Carpentry) submitted documents.', {}, -1, false);

// ───────── write / clean ─────────
const ORDER = ['properties', 'property_media', 'nearby_places', 'units', 'listing_ai_reviews', 'property_documents', 'tenancies', 'lease_renewals', 'rent_reminders', 'rentsave_plans',
  'bookings', 'subscriptions', 'maintenance_requests', 'maintenance_media', 'maintenance_events', 'jobs', 'job_media', 'job_quotes', 'job_declines', 'job_reports', 'job_reviews',
  'payments', 'rent_payments', 'escrows', 'withdrawals', 'wallet_transactions', 'bank_accounts', 'conversations', 'messages', 'calls', 'reviews', 'review_helpful', 'review_flags', 'reports',
  'saved_properties', 'saved_collections', 'saved_collection_items', 'notifications', 'verifications', 'artisan_profiles', 'artisan_documents', 'artisan_portfolio', 'artisan_references',
  'user_documents', 'support_tickets', 'app_feedback', 'admin_actions', 'admin_notes', 'announcements'];
const KEY = { listing_ai_reviews: 'property_id', bank_accounts: 'user_id', artisan_profiles: 'user_id', saved_properties: 'user_id,property_id', review_helpful: 'review_id,user_id',
  review_flags: 'review_id,user_id', job_declines: 'job_id,artisan_id', saved_collection_items: 'collection_id,property_id' };
const KEEP_EXISTING = new Set(['bank_accounts', 'artisan_profiles']); // never overwrite a user's own row
const missing = Object.keys(rows).filter((t) => !ORDER.includes(t));
if (missing.length) throw new Error('Tables missing from ORDER: ' + missing.join(', '));

const chunks = (a, n = 200) => Array.from({ length: Math.ceil(a.length / n) }, (_, i) => a.slice(i * n, i * n + n));
async function must(p, what) { const { error } = await p; if (error) throw new Error(`${what}: ${error.message}`); }

if (DRY) {
  for (const t of ORDER) if (rows[t]?.length) console.log(`would seed ${t.padEnd(24)} ${rows[t].length}`);
  console.log(`would seed ${'property_views'.padEnd(24)} ${VIEWS.length}`);
} else if (CLEAN) {
  for (const t of [...ORDER].reverse()) {
    const list = rows[t] ?? [];
    if (!list.length) continue;
    const cols = (KEY[t] ?? 'id').split(',');
    if (t === 'bank_accounts') { await must(db.from(t).delete().like('paystack_recipient_code', 'RCP_SEED_%'), t); continue; }
    if (t === 'artisan_profiles') { await must(db.from(t).delete().eq('user_id', U.dolapoA).eq('submitted_at', '2026-11-18T09:05:00Z'), t); continue; }
    if (cols.length === 1) for (const c of chunks(list.map((r) => r[cols[0]]), 100)) await must(db.from(t).delete().in(cols[0], c), t);
    else for (const r of list) await must(db.from(t).delete().match(Object.fromEntries(cols.map((c) => [c, r[c]]))), t);
    console.log(`removed  ${t.padEnd(24)} ${list.length}`);
  }
  await must(db.from('property_views').delete().in('property_id', Object.values(P).map((p) => p.id)), 'property_views');
  console.log('Sample data removed.');
} else {
  for (const t of ORDER) {
    const list = rows[t] ?? [];
    if (!list.length) continue;
    for (const c of chunks(list)) await must(db.from(t).upsert(c, { onConflict: KEY[t] ?? 'id', ignoreDuplicates: KEEP_EXISTING.has(t) }), t);
    console.log(`seeded   ${t.padEnd(24)} ${list.length}`);
  }
  await must(db.from('property_views').delete().in('property_id', Object.values(P).map((p) => p.id)), 'property_views');
  for (const c of chunks(VIEWS)) await must(db.from('property_views').insert(c), 'property_views');
  console.log(`seeded   ${'property_views'.padEnd(24)} ${VIEWS.length}`);
  console.log('\nDone. Remove it all later with: node scripts/seed-sample-data.mjs --clean');
}
