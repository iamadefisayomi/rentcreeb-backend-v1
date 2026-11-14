import { Router } from 'express';
import { z } from 'zod';
import PDFDocument from 'pdfkit';
import { db } from '../lib/supabase';
import { authenticate, requireRole } from '../middleware/auth';
import { fullName, uuid } from '../lib/common';
import { currentMonth, financeOverview, maintenanceReport, rentCollection, transactions } from '../services/finance';

const r = Router();
r.use(authenticate);

const sum = (rows: any[] | null, f: (x: any) => number) => (rows ?? []).reduce((s, x) => s + f(x), 0);
const monthKey = (d: string) => d.slice(0, 7);
function lastMonths(n: number) {
  return Array.from({ length: n }, (_, i) => { const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() - (n - 1 - i)); return d.toISOString().slice(0, 7); });
}
const monthStart = () => { const d = new Date(); d.setDate(1); d.setHours(0, 0, 0, 0); return d.toISOString(); };

/** Tenant: rent tracking, savings overview, open maintenance, recent transactions. */
/** Tenant dashboard (Figma "Tenant Dashboard" 4502:3290): rent, RentSave, upcoming inspections, maintenance, transactions. */
r.get('/tenant', requireRole('tenant'), async (req, res) => {
  const uid = req.user.id;
  const [tenancies, plans, maint, tx, bookings] = await Promise.all([
    db.from('tenancies').select('*, properties(title, address, area), rent_payments(id, amount_kobo, due_date, status, payment_id, paid_at)').eq('tenant_id', uid).eq('status', 'active'),
    db.from('rentsave_plans').select('*').eq('tenant_id', uid).neq('status', 'paused'),
    db.from('maintenance_requests').select('id, category, description, status, created_at, jobs(status, artisan:profiles!jobs_artisan_id_fkey(first_name, last_name))')
      .eq('tenant_id', uid).in('status', ['open', 'job_posted', 'in_progress']).order('created_at', { ascending: false }),
    db.from('payments').select('id, purpose, amount_kobo, status, created_at, paid_at, booking_id, tenancy_id, rentsave_plan_id').eq('user_id', uid).eq('status', 'success').order('created_at', { ascending: false }).limit(5),
    db.from('bookings').select('id, scheduled_at, status, properties(title, area, property_media(url, position)), host:profiles!bookings_host_id_fkey(first_name, last_name)')
      .eq('tenant_id', uid).in('status', ['paid', 'confirmed']).gte('scheduled_at', new Date().toISOString()).order('scheduled_at').limit(3),
  ]);
  const planRows = plans.data ?? [];
  res.json({
    rent: (tenancies.data ?? []).map((t: any) => {
      const pays = (t.rent_payments ?? []) as any[];
      const lastPaid = pays.filter((p) => p.status === 'paid' && p.payment_id).sort((a, b) => (b.paid_at ?? '').localeCompare(a.paid_at ?? ''))[0];
      return {
        tenancyId: t.id, property: t.properties, rentKobo: t.rent_kobo, frequency: t.frequency, nextDueDate: t.next_due_date, leaseStart: t.lease_start,
        due: pays.filter((p) => p.status !== 'paid').sort((a, b) => a.due_date.localeCompare(b.due_date))[0] ?? null,
        lastReceiptPaymentId: lastPaid?.payment_id ?? null,
      };
    }),
    savings: {
      totalSavedKobo: sum(planRows, (p) => Number(p.saved_kobo)), targetKobo: sum(planRows, (p) => Number(p.target_kobo)),
      frequency: planRows[0]?.frequency ?? null, plans: planRows,
    },
    openMaintenance: (maint.data ?? []).map((m: any) => {
      const job = (m.jobs ?? [])[0];
      return { id: m.id, category: m.category, description: m.description, status: m.status, created_at: m.created_at,
        jobStatus: job?.status ?? null, artisanName: job?.artisan ? fullName(job.artisan) : null };
    }),
    upcomingInspections: (bookings.data ?? []).map((b: any) => ({
      id: b.id, scheduledAt: b.scheduled_at, status: b.status, property: { title: b.properties?.title, area: b.properties?.area },
      image: [...(b.properties?.property_media ?? [])].sort((x: any, y: any) => x.position - y.position)[0]?.url ?? null,
      agentName: b.host ? fullName(b.host) : null,
    })),
    recentTransactions: tx.data,
  });
});

/** Landlord / estate manager: units, tenants, payments, tickets. */
r.get('/landlord', requireRole('landlord', 'estate_manager'), async (req, res) => {
  const [props, tenancies, maint] = await Promise.all([
    db.from('properties').select('id, title, status').eq('owner_id', req.user.id).neq('status', 'archived').order('created_at', { ascending: false }),
    db.from('tenancies')
      .select('id, property_id, tenant_id, unit_label, lease_end, rent_kobo, tenant:profiles!tenancies_tenant_id_fkey(first_name, last_name), rent_payments(status, amount_kobo, due_date, paid_at)')
      .eq('landlord_id', req.user.id).eq('status', 'active'),
    db.from('maintenance_requests')
      .select('id, category, status, urgency, created_at, property_id, tenant:profiles!maintenance_requests_tenant_id_fkey(first_name, last_name)')
      .eq('landlord_id', req.user.id).in('status', ['open', 'job_posted', 'in_progress']).order('created_at', { ascending: false }),
  ]);
  const P = props.data ?? [];
  const T = (tenancies.data ?? []) as any[];
  const M = (maint.data ?? []) as any[];
  const rp = T.flatMap((t) => t.rent_payments ?? []);
  const now = new Date();
  const today = now.toISOString().slice(0, 10);
  const in30 = new Date(now.getTime() + 30 * 864e5).toISOString().slice(0, 10);
  const mStart = monthStart();
  const kobo = (p: any) => Number(p.amount_kobo);
  const title = (id: string) => P.find((p) => p.id === id)?.title ?? 'Property';
  const name = (p: any) => (p ? `${p.first_name ?? ''} ${p.last_name ?? ''}`.trim() : null);

  // Rent state per tenancy, using payments that have fallen due (to date).
  const dueToDate = (t: any) => (t.rent_payments ?? []).filter((p: any) => p.due_date <= today);
  const rentStatus = (t: any): 'paid' | 'overdue' => (dueToDate(t).some((p: any) => p.status !== 'paid') ? 'overdue' : 'paid');

  const properties = P.map((p) => {
    const ts = T.filter((t) => t.property_id === p.id);
    const due = ts.flatMap(dueToDate);
    const dueKobo = sum(due, kobo);
    const overdue = ts.filter((t) => rentStatus(t) === 'overdue').length;
    return {
      id: p.id, title: p.title, status: p.status,
      units: Math.max(1, ts.length), occupiedUnits: ts.length,
      tenantName: ts.length === 1 ? name(ts[0].tenant) : null,
      overdueCount: overdue,
      collectionPercent: dueKobo ? Math.round((sum(due.filter((x: any) => x.status === 'paid'), kobo) / dueKobo) * 100) : 100,
      rentStatus: ts.length === 0 ? 'vacant' : overdue ? 'overdue' : 'paid',
    };
  });

  const due = rp.filter((p: any) => p.due_date <= today);
  const expiring = T.filter((t) => t.lease_end && t.lease_end >= today && t.lease_end <= in30)
    .map((t) => ({ tenancyId: t.id, propertyId: t.property_id, propertyTitle: title(t.property_id), unitLabel: t.unit_label, leaseEnd: t.lease_end,
      daysLeft: Math.max(0, Math.round((new Date(t.lease_end).getTime() - new Date(today).getTime()) / 864e5)) }))
    .sort((a, b) => a.daysLeft - b.daysLeft);

  res.json({
    // Original fields (kept for older clients)
    units: P.length, activeTenants: T.length,
    rentCollectedKobo: sum(rp.filter((p: any) => p.status === 'paid'), kobo),
    rentOutstandingKobo: sum(rp.filter((p: any) => p.status !== 'paid' && p.due_date <= today), kobo),
    openMaintenanceTickets: M.length,
    // Dashboard v2
    propertiesCount: P.length,
    totalUnits: sum(properties, (p) => p.units),
    occupiedUnits: T.length,
    vacantUnits: properties.filter((p) => p.occupiedUnits === 0).length,
    monthIncomeKobo: sum(rp.filter((p: any) => p.status === 'paid' && p.paid_at && p.paid_at >= mStart), kobo),
    collection: {
      dueKobo: sum(due, kobo),
      collectedKobo: sum(due.filter((p: any) => p.status === 'paid'), kobo),
      paidTenancies: T.filter((t) => rentStatus(t) === 'paid').length,
      overdueTenancies: T.filter((t) => rentStatus(t) === 'overdue').length,
    },
    properties,
    tickets: M.slice(0, 5).map((m) => ({ id: m.id, category: m.category, status: m.status, urgency: m.urgency, createdAt: m.created_at,
      propertyId: m.property_id, propertyTitle: title(m.property_id), tenantName: name(m.tenant) })),
    expiringLeasesCount: expiring.length,
    expiringLeases: expiring.slice(0, 5),
  });
});

/** Financial reports: rent by month, outstanding, repair spend. ?months=6 */
r.get('/landlord/reports', requireRole('landlord', 'estate_manager'), async (req, res) => {
  const { months } = z.object({ months: z.coerce.number().int().min(1).max(24).default(6) }).parse(req.query);
  const keys = lastMonths(months);
  const since = `${keys[0]}-01`;
  const { data: ten } = await db.from('tenancies').select('id').eq('landlord_id', req.user.id);
  const ids = (ten ?? []).map((t) => t.id);
  const { data: rent } = ids.length ? await db.from('rent_payments').select('amount_kobo, paid_at').in('tenancy_id', ids).eq('status', 'paid').gte('paid_at', since) : { data: [] as any[] };
  const { data: repairs } = await db.from('escrows').select('amount_kobo, created_at, jobs!inner(landlord_id)').eq('kind', 'job').eq('jobs.landlord_id', req.user.id).gte('created_at', since);
  res.json({ months: keys.map((m) => ({
    month: m,
    rentCollectedKobo: sum((rent ?? []).filter((p: any) => monthKey(p.paid_at) === m), (p) => Number(p.amount_kobo)),
    repairSpendKobo: sum((repairs ?? []).filter((p: any) => monthKey(p.created_at) === m), (p) => Number(p.amount_kobo)),
  })) });
});

/** Agent: bookings, revenue, properties, subscription. */
/** Agent dashboard (Figma "AgentDashboard" 4548:23). */
r.get('/agent', requireRole('agent', 'landlord', 'estate_manager'), async (req, res) => {
  const uid = req.user.id;
  const [bk, props, esc, sub, wallet, recent] = await Promise.all([
    db.from('bookings').select('id, status, scheduled_at, created_at, property_id').eq('host_id', uid),
    db.from('properties').select('id, title, status, price_kobo, price_period, property_media(url, position)').eq('owner_id', uid).neq('status', 'archived').order('created_at', { ascending: false }),
    db.from('escrows').select('amount_kobo, fee_kobo, status, released_at').eq('payee_id', uid).eq('kind', 'inspection'),
    db.from('subscriptions').select('status, starts_at, expires_at, subscription_plans(name, listing_limit)').eq('agent_id', uid).eq('status', 'active').maybeSingle(),
    db.from('wallets').select('available_kobo').eq('user_id', uid).single(),
    db.from('bookings').select('id, status, scheduled_at, properties(title, property_media(url, position)), tenant:profiles!bookings_tenant_id_fkey(first_name, last_name)')
      .eq('host_id', uid).in('status', ['paid', 'confirmed', 'completed', 'cancelled']).order('scheduled_at', { ascending: false }).limit(5),
  ]);
  const b = bk.data ?? [];
  const P = props.data ?? [];
  const net = (e: any) => Number(e.amount_kobo) - Number(e.fee_kobo);
  const released = (esc.data ?? []).filter((e) => e.status === 'released');
  const mStart = new Date(monthStart());
  const lastStart = new Date(mStart); lastStart.setMonth(lastStart.getMonth() - 1);
  const thisMonth = sum(released.filter((e) => e.released_at && new Date(e.released_at) >= mStart), net);
  const lastMonth = sum(released.filter((e) => e.released_at && new Date(e.released_at) >= lastStart && new Date(e.released_at) < mStart), net);
  const weekAgo = Date.now() - 7 * 864e5;
  const bookingsPer = new Map<string, number>();
  for (const x of b) bookingsPer.set(x.property_id, (bookingsPer.get(x.property_id) ?? 0) + 1);
  const cover = (m: any[] | null) => [...(m ?? [])].sort((x, y) => x.position - y.position)[0]?.url ?? null;
  const approved = P.filter((p) => p.status === 'approved').length;
  const limit = (sub.data as any)?.subscription_plans?.listing_limit ?? null;

  res.json({
    revenueKobo: sum(released, net),
    revenueThisMonthKobo: thisMonth,
    revenueChangePct: lastMonth ? Math.round(((thisMonth - lastMonth) / lastMonth) * 100) : null,
    pendingRevenueKobo: sum((esc.data ?? []).filter((e) => e.status === 'held'), net),
    walletKobo: wallet.data?.available_kobo ?? 0,
    bookings: {
      total: b.length, upcoming: b.filter((x) => x.status === 'confirmed').length, completed: b.filter((x) => x.status === 'completed').length,
      awaitingOtp: b.filter((x) => x.status === 'paid').length, thisWeek: b.filter((x) => new Date(x.created_at).getTime() >= weekAgo).length,
    },
    listings: { total: P.length, approved, pending: P.filter((p) => p.status === 'pending').length, rejected: P.filter((p) => p.status === 'rejected').length },
    subscription: sub.data ? { ...sub.data, usage: limit ? { used: approved, limit, percent: Math.min(100, Math.round((approved / limit) * 100)) } : null } : null,
    rating: { average: req.user.rating_avg, count: req.user.rating_count },
    recentBookings: (recent.data ?? []).map((x: any) => ({
      id: x.id, status: x.status, scheduledAt: x.scheduled_at, propertyTitle: x.properties?.title ?? '', image: cover(x.properties?.property_media),
      tenantName: x.tenant ? fullName(x.tenant) : null,
    })),
    topListings: P.slice(0, 6).map((p: any) => ({ id: p.id, title: p.title, status: p.status, priceKobo: p.price_kobo, pricePeriod: p.price_period, image: cover(p.property_media), bookings: bookingsPer.get(p.id) ?? 0 })),
  });
});

/** Revenue & performance analytics. ?months=6 */
/**
 * Agent Analytics (Figma 4563:9890): Hub (overview), Bookings and Transactions tabs.
 * `months` sets the window for the series, status counts, views and ledger.
 */
r.get('/agent/analytics', requireRole('agent', 'landlord', 'estate_manager'), async (req, res) => {
  const { months } = z.object({ months: z.coerce.number().int().min(1).max(24).default(6) }).parse(req.query);
  const keys = lastMonths(months);
  const since = `${keys[0]}-01`;
  const [bk, esc, props, wd, wallet] = await Promise.all([
    db.from('bookings').select('id, status, created_at, scheduled_at, amount_kobo, fee_kobo, property_id, properties(title, area), tenant:profiles!bookings_tenant_id_fkey(first_name, last_name, avatar_url)')
      .eq('host_id', req.user.id).gte('created_at', since).order('scheduled_at', { ascending: false }),
    db.from('escrows').select('id, amount_kobo, fee_kobo, status, created_at, released_at, booking_id, bookings(scheduled_at, properties(title))')
      .eq('payee_id', req.user.id).eq('kind', 'inspection').gte('created_at', since).order('created_at', { ascending: false }),
    db.from('properties').select('id, title').eq('owner_id', req.user.id).neq('status', 'archived'),
    db.from('withdrawals').select('id, amount_kobo, status, reference, created_at').eq('user_id', req.user.id).gte('created_at', since).order('created_at', { ascending: false }),
    db.from('wallets').select('available_kobo').eq('user_id', req.user.id).maybeSingle(),
  ]);
  const ids = (props.data ?? []).map((p) => p.id);
  const { data: views } = ids.length ? await db.from('property_views').select('property_id, created_at').in('property_id', ids).gte('created_at', since) : { data: [] as any[] };
  const b: any[] = bk.data ?? []; const e: any[] = esc.data ?? []; const v = views ?? [];
  const net = (x: any) => Number(x.amount_kobo) - Number(x.fee_kobo);
  const released = e.filter((x) => x.status === 'released');
  const counted = b.filter((x) => !['expired', 'pending_payment'].includes(x.status));
  const STATUSES = ['paid', 'confirmed', 'completed', 'cancelled', 'declined', 'refunded'] as const;

  const ledger = [
    ...e.map((x) => ({ id: x.id, kind: x.status === 'refunded' ? 'refund' : 'inspection', status: x.status,
      title: x.bookings?.properties?.title ?? 'Inspection fee', amountKobo: net(x), feeKobo: Number(x.fee_kobo), date: x.released_at ?? x.created_at, bookingId: x.booking_id })),
    ...(wd.data ?? []).map((w: any) => ({ id: w.id, kind: 'withdrawal', status: w.status, title: 'Withdrawal to bank', amountKobo: -Number(w.amount_kobo), feeKobo: 0, date: w.created_at, bookingId: null })),
  ].sort((x, y) => String(y.date).localeCompare(String(x.date)));

  res.json({
    series: keys.map((m) => ({ month: m,
      bookings: counted.filter((x) => monthKey(x.created_at) === m).length,
      completed: b.filter((x) => x.status === 'completed' && monthKey(x.created_at) === m).length,
      views: v.filter((x) => monthKey(x.created_at) === m).length,
      revenueKobo: sum(released.filter((x) => monthKey(x.released_at) === m), net) })),
    conversionRate: counted.length ? +(b.filter((x) => x.status === 'completed').length / counted.length * 100).toFixed(1) : 0,
    viewToBookingRate: v.length ? +(counted.length / v.length * 100).toFixed(1) : 0,
    totals: {
      revenueKobo: sum(released, net), pendingKobo: sum(e.filter((x) => x.status === 'held'), net),
      withdrawnKobo: sum((wd.data ?? []).filter((w: any) => w.status !== 'failed'), (w: any) => Number(w.amount_kobo)),
      walletKobo: Number(wallet.data?.available_kobo ?? 0), feesKobo: sum(released, (x) => Number(x.fee_kobo)),
      bookings: counted.length, views: v.length,
    },
    statusCounts: Object.fromEntries(STATUSES.map((st) => [st, b.filter((x) => x.status === st).length])),
    // Busiest days (Figma "Booking Analytics"): inspections per weekday, Mon..Sun, cancelled ones excluded.
    weekdays: [1, 2, 3, 4, 5, 6, 0].map((d) => b.filter((x) => !['cancelled', 'expired', 'declined', 'refunded'].includes(x.status) && new Date(x.scheduled_at).getDay() === d).length),
    recentBookings: counted.slice(0, 30).map((x) => ({ id: x.id, status: x.status, scheduledAt: x.scheduled_at, amountKobo: Number(x.amount_kobo), property: x.properties?.title ?? null, area: x.properties?.area ?? null,
      tenant: x.tenant ? `${x.tenant.first_name ?? ''} ${x.tenant.last_name ?? ''}`.trim() : null, tenantAvatar: x.tenant?.avatar_url ?? null })),
    ledger: ledger.slice(0, 50),
    topProperties: (props.data ?? []).map((p) => ({ propertyId: p.id, title: p.title,
      bookings: counted.filter((x) => x.property_id === p.id).length, views: v.filter((x) => x.property_id === p.id).length }))
      .sort((x, y) => y.bookings - x.bookings || y.views - x.views).slice(0, 5),
    rating: { average: req.user.rating_avg, count: req.user.rating_count },
  });
});

/** Artisan dashboard + earnings screen. */
const weekStart = () => { const d = new Date(); const day = (d.getDay() + 6) % 7; d.setDate(d.getDate() - day); d.setHours(0, 0, 0, 0); return d.toISOString(); };
const ACTIVE_JOB = ['assigned', 'diagnosing', 'awaiting_approval', 'approved', 'in_progress', 'awaiting_confirmation'];

/** Artisan dashboard + Earnings (Figma 4579:3128 / 4579:2353). */
r.get('/artisan', requireRole('artisan'), async (req, res) => {
  const uid = req.user.id;
  const [ap, wallet, esc, jobs, wtx, alerts, pending, portfolio, certs, refs] = await Promise.all([
    db.from('artisan_profiles').select('review_status, skill_category').eq('user_id', uid).maybeSingle(),
    db.from('wallets').select('available_kobo').eq('user_id', uid).single(),
    db.from('escrows').select('amount_kobo, fee_kobo, status, released_at, created_at, jobs(title, properties(area))').eq('payee_id', uid).eq('kind', 'job'),
    db.from('jobs').select('id, title, status, started_at, completed_at, properties(title, area), landlord:profiles!jobs_landlord_id_fkey(first_name, last_name), job_reports(est_completion, created_at)').eq('artisan_id', uid),
    db.from('wallet_transactions').select('amount_kobo, created_at').eq('user_id', uid).eq('kind', 'escrow_release').gte('created_at', `${lastMonths(6)[0]}-01`),
    db.from('jobs').select('id', { count: 'exact', head: true }).eq('status', 'open'),
    db.from('job_quotes').select('id', { count: 'exact', head: true }).eq('artisan_id', uid).eq('status', 'pending'),
    db.from('artisan_portfolio').select('id', { count: 'exact', head: true }).eq('user_id', uid),
    db.from('artisan_documents').select('id', { count: 'exact', head: true }).eq('user_id', uid).eq('doc_type', 'trade_certificate'),
    db.from('artisan_references').select('id', { count: 'exact', head: true }).eq('user_id', uid),
  ]);
  const e = esc.data ?? [];
  const released = e.filter((x) => x.status === 'released');
  const held = e.filter((x) => x.status === 'held');
  const net = (x: any) => Number(x.amount_kobo) - Number(x.fee_kobo);
  const j = jobs.data ?? [];
  const wk = weekStart();

  // Profile completeness: each item links to where it's fixed; the first missing one is offered as the next step.
  const steps: [boolean, string][] = [
    [!!req.user.avatar_url, 'Add a profile photo'],
    [!!req.user.bio, 'Add a bio'],
    [(portfolio.count ?? 0) > 0, 'Add portfolio photos'],
    [(certs.count ?? 0) > 0, 'Add a certification'],
    [(refs.count ?? 0) > 0, 'Add a reference'],
  ];
  const done = steps.filter(([ok]) => ok).length;

  res.json({
    reviewStatus: ap.data?.review_status, skillCategory: ap.data?.skill_category ?? null,
    rating: { average: req.user.rating_avg, count: req.user.rating_count },
    profile: { percent: Math.round((done / steps.length) * 100), nextStep: steps.find(([ok]) => !ok)?.[1] ?? null },
    earnings: {
      totalKobo: sum(released, net),
      thisMonthKobo: sum(released.filter((x) => x.released_at >= monthStart()), net),
      thisWeekKobo: sum(released.filter((x) => x.released_at >= wk), net),
      jobsThisWeek: j.filter((x) => x.status === 'completed' && (x.completed_at ?? '') >= wk).length,
      escrowKobo: sum(held, net),
      escrowJobs: held.length,
      walletKobo: wallet.data?.available_kobo ?? 0, jobsDone: j.filter((x) => x.status === 'completed').length,
      monthly: lastMonths(6).map((m) => ({ month: m, kobo: sum((wtx.data ?? []).filter((t) => monthKey(t.created_at) === m), (t) => Number(t.amount_kobo)) })),
      recent: e.sort((a, b) => (b.released_at ?? b.created_at ?? '').localeCompare(a.released_at ?? a.created_at ?? '')).slice(0, 10),
    },
    activeJobs: j.filter((x) => ACTIVE_JOB.includes(x.status)).map((x: any) => {
      const reports = (x.job_reports ?? []).sort((a: any, b: any) => (b.created_at ?? '').localeCompare(a.created_at ?? ''));
      return { id: x.id, title: x.title, status: x.status, started_at: x.started_at, properties: x.properties,
        landlordName: fullName(x.landlord ?? {}) || null, estCompletion: reports[0]?.est_completion ?? null };
    }),
    awaitingResponse: pending.count ?? 0,
    openJobsCount: alerts.count ?? 0,
  });
});

// ───────────────────────── Landlord / estate manager: money & oversight ─────────────────────────
const MANAGERS = ['landlord', 'estate_manager'] as const;
const monthParam = z.string().regex(/^\d{4}-\d{2}$/, 'Use YYYY-MM').default(() => currentMonth());

/** Rent Collection (Figma "Rent Overview"): instalments due in a month, per tenant. ?month=YYYY-MM&propertyId= */
r.get('/landlord/rent', requireRole(...MANAGERS), async (req, res) => {
  const q = z.object({ month: monthParam, propertyId: uuid.optional() }).parse(req.query);
  res.json(await rentCollection({ landlordId: req.user.id, propertyId: q.propertyId }, q.month));
});

/** Financial Reports overview + the landlord's properties (for the filter chips). */
r.get('/landlord/finance', requireRole(...MANAGERS), async (req, res) => {
  const q = z.object({ month: monthParam, propertyId: uuid.optional() }).parse(req.query);
  const [overview, props] = await Promise.all([
    financeOverview({ landlordId: req.user.id, propertyId: q.propertyId }, q.month),
    db.from('properties').select('id, title').eq('owner_id', req.user.id).neq('status', 'archived').order('title'),
  ]);
  res.json({ ...overview, properties: props.data ?? [] });
});

/** All Transactions. ?type=income|expenses|pending&months=6&q=&propertyId= */
r.get('/landlord/transactions', requireRole(...MANAGERS), async (req, res) => {
  const q = z.object({ type: z.enum(['income', 'expenses', 'pending']).optional(), months: z.coerce.number().int().min(1).max(24).default(6), q: z.string().optional(), propertyId: uuid.optional() }).parse(req.query);
  res.json({ transactions: await transactions({ landlordId: req.user.id, propertyId: q.propertyId }, q) });
});

/** Maintenance Reports. ?range=month|3m|6m&propertyId= */
r.get('/landlord/maintenance', requireRole(...MANAGERS), async (req, res) => {
  const q = z.object({ range: z.enum(['month', '3m', '6m']).default('month'), propertyId: uuid.optional() }).parse(req.query);
  res.json(await maintenanceReport({ landlordId: req.user.id, propertyId: q.propertyId }, q.range));
});

/**
 * Export Report → PDF (Figma "Export Report"). ?month=YYYY-MM&propertyId=&sections=income,expenses,property,transactions,maintenance,tenants
 * The app downloads it with the user's bearer token (expo-file-system) and hands it to the share sheet.
 */
r.get('/landlord/report.pdf', requireRole(...MANAGERS), async (req, res) => {
  const SECTIONS = ['income', 'expenses', 'property', 'transactions', 'maintenance', 'tenants'] as const;
  const q = z.object({
    month: monthParam, propertyId: uuid.optional(),
    sections: z.string().default('income,expenses,property,transactions').transform((s) => s.split(',').filter((x): x is typeof SECTIONS[number] => (SECTIONS as readonly string[]).includes(x))),
  }).parse(req.query);
  const scope = { landlordId: req.user.id, propertyId: q.propertyId };
  const [fin, tx, maint, rent, prop] = await Promise.all([
    financeOverview(scope, q.month),
    q.sections.includes('transactions') ? transactions(scope, { months: 1 }) : Promise.resolve([]),
    q.sections.includes('maintenance') ? maintenanceReport(scope, 'month') : Promise.resolve(null),
    q.sections.includes('tenants') ? rentCollection(scope, q.month) : Promise.resolve(null),
    q.propertyId ? db.from('properties').select('title').eq('id', q.propertyId).maybeSingle() : Promise.resolve({ data: null }),
  ]);
  const naira = (k: number) => `NGN ${(k / 100).toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const monthLabel = new Date(`${q.month}-01T00:00:00Z`).toLocaleDateString('en-NG', { month: 'long', year: 'numeric', timeZone: 'UTC' });

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="rentcreeb-report-${q.month}.pdf"`);
  const doc = new PDFDocument({ margin: 50, size: 'A4' });
  doc.pipe(res);
  const NAVY = '#242549', SOFT = '#585B8B', BLUE = '#2E62FF', GREEN = '#00875A', RED = '#C62828';
  const heading = (t: string) => { doc.moveDown(1).fillColor(NAVY).fontSize(13).text(t); doc.moveTo(50, doc.y + 3).lineTo(545, doc.y + 3).strokeColor('#E4E8F5').stroke(); doc.moveDown(0.6); };
  const row = (label: string, value: string, color = NAVY) => {
    const y = doc.y; doc.fontSize(10).fillColor(SOFT).text(label, 50, y, { width: 330 }); doc.fillColor(color).text(value, 380, y, { width: 165, align: 'right' }); doc.moveDown(0.35);
  };

  doc.fillColor(BLUE).fontSize(22).text('RentCreeb').fillColor(NAVY).fontSize(15).text('Financial report').moveDown(0.3);
  doc.fontSize(10).fillColor(SOFT).text(`${monthLabel} · ${prop.data?.title ?? 'All properties'} · ${fullName(req.user)}`);
  doc.text(`Generated ${new Date().toLocaleString('en-NG')}`);

  if (q.sections.includes('income')) {
    heading('Income summary');
    row('Rent expected', naira(fin.rentExpectedKobo)); row('Rent collected', naira(fin.rentCollectedKobo), GREEN);
    row('Outstanding', naira(fin.outstandingKobo), RED); row('Total income received this month', naira(fin.incomeKobo));
    row('Net income (income − expenses)', naira(fin.netIncomeKobo), BLUE);
    row('Year to date — income / expenses / net', `${naira(fin.ytd.incomeKobo)} / ${naira(fin.ytd.expensesKobo)} / ${naira(fin.ytd.netKobo)}`);
  }
  if (q.sections.includes('expenses')) {
    heading('Expense breakdown');
    if (!fin.expenseDetail.length) doc.fontSize(10).fillColor(SOFT).text('No expenses recorded this month.');
    for (const g of fin.expenseDetail) { row(g.category, naira(g.amountKobo), RED); for (const it of g.items) row(`   ${it.title ?? ''}${it.property ? ` · ${it.property}` : ''}`, naira(it.amountKobo)); }
  }
  if (q.sections.includes('property')) {
    heading('Per-unit income');
    row('Units occupied', `${fin.unitsOccupied} of ${fin.unitsTotal}`); row('Tenants paid', `${fin.paidCount} of ${fin.dueCount}`);
    for (const u of fin.incomeDetail) row(`${u.unit ?? '—'} · ${u.name}${u.property && !q.propertyId ? ` (${u.property})` : ''}`, `${naira(u.amountKobo)} · ${u.status}`, u.status === 'paid' ? GREEN : u.status === 'overdue' ? RED : NAVY);
  }
  if (q.sections.includes('transactions')) {
    heading('Transaction history');
    if (!tx.length) doc.fontSize(10).fillColor(SOFT).text('No transactions this month.');
    for (const t of tx.filter((x) => x.date.slice(0, 7) === q.month)) row(`${t.date.slice(0, 10)}  ${t.title} — ${t.subtitle}`, `${t.kind === 'expense' ? '−' : t.kind === 'income' ? '+' : ''}${naira(t.amountKobo)}`, t.kind === 'expense' ? RED : t.kind === 'income' ? GREEN : NAVY);
  }
  if (maint) {
    heading('Maintenance details');
    row('Tickets this month', String(maint.totalTickets)); row('Average resolution', maint.avgResolutionDays === null ? '—' : `${maint.avgResolutionDays} days`);
    row('SLA compliance', maint.slaCompliance === null ? '—' : `${maint.slaCompliance}%`); row('Repair cost', naira(maint.totalRepairCostKobo));
    for (const c of maint.byCategory) row(`   ${c.name}`, `${c.count} ticket${c.count === 1 ? '' : 's'}`);
  }
  if (rent) {
    heading('Tenant payment history');
    for (const t of rent.tenants) row(`${t.name}${t.unit ? ` · ${t.unit}` : ''} — due ${t.dueDate}`, `${naira(t.paidKobo)} of ${naira(t.amountKobo)} · ${t.status}`, t.status === 'paid' ? GREEN : t.status === 'upcoming' ? NAVY : RED);
  }
  doc.end();
});

export default r;
