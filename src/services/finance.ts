import { db } from '../lib/supabase';
import { fullName } from '../lib/common';

/**
 * Landlord money maths shared by the Rent Collection, Financial Reports and Maintenance Reports screens and the
 * PDF export, so every surface shows the same numbers.
 * Months are 'YYYY-MM'. Income = rent instalments marked paid (any method). Expenses = repair jobs the landlord
 * funded (job escrows, dated when funded). Only data RentCreeb records is counted — no external bookkeeping.
 */
const sum = (rows: any[], f: (x: any) => number) => rows.reduce((s, x) => s + f(x), 0);
export const monthKey = (d: string) => d.slice(0, 7);
export const monthRange = (m: string) => {
  const [y, mo] = m.split('-').map(Number);
  const start = new Date(Date.UTC(y, mo - 1, 1)); const end = new Date(Date.UTC(y, mo, 1));
  return { start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10), startTs: start.toISOString(), endTs: end.toISOString() };
};
export const shiftMonth = (m: string, by: number) => { const [y, mo] = m.split('-').map(Number); const d = new Date(Date.UTC(y, mo - 1 + by, 1)); return d.toISOString().slice(0, 7); };
export const currentMonth = () => new Date().toISOString().slice(0, 7);
const today = () => new Date().toISOString().slice(0, 10);

type Scope = { landlordId: string; propertyId?: string };

/** All the landlord's tenancies (incl. ended) with unit/tenant/property, optionally one property. */
async function tenancies(s: Scope) {
  let q = db.from('tenancies').select('id, status, property_id, unit_label, invite_name, rent_kobo, frequency, tenant_id, ' +
    'properties(id, title), units(id, label), tenant:profiles!tenancies_tenant_id_fkey(id, first_name, last_name, phone, avatar_url)').eq('landlord_id', s.landlordId);
  if (s.propertyId) q = q.eq('property_id', s.propertyId);
  return ((await q).data ?? []) as any[];
}
const who = (t: any) => (t.tenant ? fullName(t.tenant) : t.invite_name ?? 'Invited tenant');
const unitOf = (t: any) => t.units?.label ?? t.unit_label ?? null;

async function rentRows(ids: string[], from?: string, to?: string) {
  if (!ids.length) return [] as any[];
  let q = db.from('rent_payments').select('id, tenancy_id, amount_kobo, due_date, status, paid_at, method, reference').in('tenancy_id', ids);
  if (from) q = q.gte('due_date', from); if (to) q = q.lt('due_date', to);
  return ((await q).data ?? []) as any[];
}
async function paidRows(ids: string[], fromTs: string, toTs: string) {
  if (!ids.length) return [] as any[];
  return ((await db.from('rent_payments').select('id, tenancy_id, amount_kobo, due_date, paid_at, method, reference').in('tenancy_id', ids)
    .eq('status', 'paid').gte('paid_at', fromTs).lt('paid_at', toTs)).data ?? []) as any[];
}
async function repairRows(s: Scope, fromTs: string, toTs: string) {
  let q = db.from('escrows').select('id, amount_kobo, created_at, status, jobs!inner(id, title, category, property_id, landlord_id, maintenance_request_id, properties(title))')
    .eq('kind', 'job').eq('jobs.landlord_id', s.landlordId).gte('created_at', fromTs).lt('created_at', toTs);
  if (s.propertyId) q = q.eq('jobs.property_id', s.propertyId);
  return ((await q).data ?? []) as any[];
}

/** Rent Collection screen: every instalment due in the month, per tenant, with collection rate. */
export async function rentCollection(s: Scope, month: string) {
  const ts = await tenancies(s);
  const byId = new Map(ts.map((t) => [t.id, t]));
  const { start, end } = monthRange(month);
  const rows = await rentRows(ts.map((t) => t.id), start, end);
  const now = today();
  const perTenancy = new Map<string, any>();
  for (const r of rows) {
    const t = byId.get(r.tenancy_id); if (!t) continue;
    const e = perTenancy.get(t.id) ?? { tenancyId: t.id, name: who(t), unit: unitOf(t), property: t.properties?.title ?? null, avatarUrl: t.tenant?.avatar_url ?? null,
      amountKobo: 0, paidKobo: 0, dueDate: r.due_date, paidAt: null as string | null, status: 'paid' as 'paid' | 'overdue' | 'upcoming' | 'partial' };
    e.amountKobo += Number(r.amount_kobo);
    if (r.status === 'paid') { e.paidKobo += Number(r.amount_kobo); e.paidAt = r.paid_at > (e.paidAt ?? '') ? r.paid_at : e.paidAt; }
    if (r.due_date < e.dueDate) e.dueDate = r.due_date;
    perTenancy.set(t.id, e);
  }
  const list = [...perTenancy.values()].map((e) => {
    const outstanding = e.amountKobo - e.paidKobo;
    const status = outstanding <= 0 ? 'paid' : e.dueDate < now ? (e.paidKobo ? 'partial' : 'overdue') : 'upcoming';
    return { ...e, outstandingKobo: outstanding, status, overdueDays: status === 'overdue' || status === 'partial' ? Math.round((Date.parse(now) - Date.parse(e.dueDate)) / 864e5) : 0 };
  }).sort((a, b) => ({ overdue: 0, partial: 1, upcoming: 2, paid: 3 } as any)[a.status] - ({ overdue: 0, partial: 1, upcoming: 2, paid: 3 } as any)[b.status] || a.dueDate.localeCompare(b.dueDate));
  const expected = sum(list, (x) => x.amountKobo);
  const collected = sum(list, (x) => x.paidKobo);
  const overdue = sum(list.filter((x) => x.status === 'overdue' || x.status === 'partial'), (x) => x.outstandingKobo);
  return {
    month, expectedKobo: expected, collectedKobo: collected, overdueKobo: overdue, upcomingKobo: expected - collected - overdue,
    collectionRate: expected ? +((collected / expected) * 100).toFixed(1) : 0, tenants: list,
  };
}

/** Financial Reports overview for one month (optionally one property). */
export async function financeOverview(s: Scope, month: string) {
  const ts = await tenancies(s);
  const ids = ts.map((t) => t.id); const byId = new Map(ts.map((t) => [t.id, t]));
  const r = monthRange(month);
  const prev = monthRange(shiftMonth(month, -1));
  const yearStart = `${month.slice(0, 4)}-01-01T00:00:00.000Z`;
  const [paid, paidPrev, repairs, repairsPrev, dueRows, ytdPaid, ytdRepairs, unitsQ] = await Promise.all([
    paidRows(ids, r.startTs, r.endTs), paidRows(ids, prev.startTs, prev.endTs),
    repairRows(s, r.startTs, r.endTs), repairRows(s, prev.startTs, prev.endTs),
    rentRows(ids, r.start, r.end), paidRows(ids, yearStart, r.endTs), repairRows(s, yearStart, r.endTs),
    s.propertyId ? db.from('units').select('id, status').eq('property_id', s.propertyId)
      : db.from('units').select('id, status, properties!inner(owner_id)').eq('properties.owner_id', s.landlordId),
  ]);
  const income = sum(paid, (x) => Number(x.amount_kobo)); const incomePrev = sum(paidPrev, (x) => Number(x.amount_kobo));
  const expenses = sum(repairs, (x) => Number(x.amount_kobo)); const expensesPrev = sum(repairsPrev, (x) => Number(x.amount_kobo));
  const expected = sum(dueRows, (x) => Number(x.amount_kobo));
  const collectedOfExpected = sum(dueRows.filter((x) => x.status === 'paid'), (x) => Number(x.amount_kobo));
  const dueTenancies = new Set(dueRows.map((x) => x.tenancy_id));
  const paidTenancies = new Set(dueRows.filter((x) => x.status === 'paid').map((x) => x.tenancy_id));
  const series = await Promise.all(Array.from({ length: 6 }, (_, i) => shiftMonth(month, i - 5)).map(async (m) => {
    const mr = monthRange(m);
    const [p, e] = await Promise.all([paidRows(ids, mr.startTs, mr.endTs), repairRows(s, mr.startTs, mr.endTs)]);
    return { month: m, incomeKobo: sum(p, (x) => Number(x.amount_kobo)), expensesKobo: sum(e, (x) => Number(x.amount_kobo)) };
  }));
  const units = (unitsQ.data ?? []) as any[];
  const pctChange = (a: number, b: number) => (b ? +(((a - b) / b) * 100).toFixed(1) : null);
  type ExpenseItem = { title: string | null; property: string | null; amountKobo: number; date: string };
  const byCategory = new Map<string, { category: string; amountKobo: number; items: ExpenseItem[] }>();
  for (const e of repairs) {
    const c = e.jobs?.category ?? 'other';
    const g = byCategory.get(c) ?? { category: c, amountKobo: 0, items: [] as ExpenseItem[] };
    g.amountKobo += Number(e.amount_kobo); g.items.push({ title: e.jobs?.title, property: e.jobs?.properties?.title, amountKobo: Number(e.amount_kobo), date: e.created_at });
    byCategory.set(c, g);
  }
  return {
    month, propertyId: s.propertyId ?? null,
    unitsTotal: units.length, unitsOccupied: units.filter((u) => u.status === 'occupied').length,
    netIncomeKobo: income - expenses, netChangeKobo: (income - expenses) - (incomePrev - expensesPrev),
    incomeKobo: income, incomeChangePct: pctChange(income, incomePrev),
    expensesKobo: expenses, expensesChangePct: pctChange(expenses, expensesPrev),
    rentExpectedKobo: expected, rentCollectedKobo: collectedOfExpected, outstandingKobo: Math.max(0, expected - collectedOfExpected),
    paidCount: paidTenancies.size, dueCount: dueTenancies.size,
    incomeDetail: [...dueTenancies].map((id) => {
      const t = byId.get(id); const rows = dueRows.filter((x) => x.tenancy_id === id);
      const isPaid = rows.every((x) => x.status === 'paid');
      return { tenancyId: id, unit: unitOf(t), name: who(t), property: t?.properties?.title ?? null, amountKobo: sum(rows, (x) => Number(x.amount_kobo)),
        paidAt: isPaid ? rows.map((x) => x.paid_at).sort().at(-1) : null, status: isPaid ? 'paid' : rows.some((x) => x.due_date < today()) ? 'overdue' : 'due' };
    }),
    expenseDetail: [...byCategory.values()],
    series,
    ytd: { incomeKobo: sum(ytdPaid, (x) => Number(x.amount_kobo)), expensesKobo: sum(ytdRepairs, (x) => Number(x.amount_kobo)),
      netKobo: sum(ytdPaid, (x) => Number(x.amount_kobo)) - sum(ytdRepairs, (x) => Number(x.amount_kobo)) },
  };
}

/** All Transactions: rent received, rent overdue (pending), repair expenses — newest first, grouped by month in the app. */
export async function transactions(s: Scope, opts: { type?: 'income' | 'expenses' | 'pending'; months?: number; q?: string }) {
  const ts = await tenancies(s); const ids = ts.map((t) => t.id); const byId = new Map(ts.map((t) => [t.id, t]));
  const from = monthRange(shiftMonth(currentMonth(), -((opts.months ?? 6) - 1)));
  const end = new Date(Date.now() + 864e5).toISOString();
  const [paid, due, repairs] = await Promise.all([
    opts.type && opts.type !== 'income' ? [] : paidRows(ids, from.startTs, end),
    opts.type && opts.type !== 'pending' ? [] : rentRows(ids, from.start, today()).then((rows) => rows.filter((x) => x.status !== 'paid')),
    opts.type && opts.type !== 'expenses' ? [] : repairRows(s, from.startTs, end),
  ]);
  const out = [
    ...paid.map((p: any) => ({ id: `rent:${p.id}`, kind: 'income' as const, title: 'Rent received', subtitle: [unitOf(byId.get(p.tenancy_id)), who(byId.get(p.tenancy_id))].filter(Boolean).join(' — '),
      amountKobo: Number(p.amount_kobo), date: p.paid_at, status: 'received', method: p.method, tenancyId: p.tenancy_id })),
    ...due.map((p: any) => ({ id: `due:${p.id}`, kind: 'pending' as const, title: 'Rent overdue', subtitle: [unitOf(byId.get(p.tenancy_id)), who(byId.get(p.tenancy_id))].filter(Boolean).join(' — '),
      amountKobo: Number(p.amount_kobo), date: p.due_date, status: 'overdue', method: null, tenancyId: p.tenancy_id })),
    ...repairs.map((e: any) => ({ id: `job:${e.id}`, kind: 'expense' as const, title: 'Maintenance expense', subtitle: [e.jobs?.category, e.jobs?.properties?.title].filter(Boolean).join(' — '),
      amountKobo: Number(e.amount_kobo), date: e.created_at, status: e.status === 'held' ? 'in escrow' : 'paid', method: 'escrow', jobId: e.jobs?.id })),
  ].sort((a, b) => b.date.localeCompare(a.date));
  const needle = opts.q?.trim().toLowerCase();
  return needle ? out.filter((x) => `${x.title} ${x.subtitle}`.toLowerCase().includes(needle)) : out;
}

/** Maintenance Reports: volume, speed, SLA compliance and cost over a range. */
export async function maintenanceReport(s: Scope, range: 'month' | '3m' | '6m') {
  const monthsBack = range === 'month' ? 1 : range === '3m' ? 3 : 6;
  const since = new Date(Date.now() - monthsBack * 30 * 864e5).toISOString();
  const prevSince = new Date(Date.now() - 2 * monthsBack * 30 * 864e5).toISOString();
  let q = db.from('maintenance_requests').select('id, category, priority, status, created_at, resolved_at, sla_due_at, property_id, properties(title), jobs(id, job_reports(status, materials, labor_kobo, total_kobo))')
    .eq('landlord_id', s.landlordId).gte('created_at', prevSince);
  if (s.propertyId) q = q.eq('property_id', s.propertyId);
  const all = ((await q).data ?? []) as any[];
  const cur = all.filter((m) => m.created_at >= since); const prev = all.filter((m) => m.created_at < since);
  const resolved = cur.filter((m) => m.resolved_at);
  const avgDays = resolved.length ? +(sum(resolved, (m) => (Date.parse(m.resolved_at) - Date.parse(m.created_at)) / 864e5) / resolved.length).toFixed(1) : null;
  const prevResolved = prev.filter((m) => m.resolved_at);
  const prevAvg = prevResolved.length ? sum(prevResolved, (m) => (Date.parse(m.resolved_at) - Date.parse(m.created_at)) / 864e5) / prevResolved.length : null;
  const onTime = resolved.filter((m) => !m.sla_due_at || m.resolved_at <= m.sla_due_at).length;
  const cost = { materialsKobo: 0, laborKobo: 0, emergencyKobo: 0 };
  for (const m of cur) {
    const rep = (m.jobs ?? []).flatMap((j: any) => j.job_reports ?? []).find((r: any) => r.status === 'approved');
    if (!rep) continue;
    const materials = sum(rep.materials ?? [], (x: any) => Number(x.qty) * Number(x.costKobo));
    if (m.priority === 'emergency') cost.emergencyKobo += Number(rep.total_kobo);
    else { cost.materialsKobo += materials; cost.laborKobo += Number(rep.labor_kobo); }
  }
  const count = (key: (m: any) => string) => { const c = new Map<string, number>(); for (const m of cur) c.set(key(m), (c.get(key(m)) ?? 0) + 1); return [...c].map(([name, n]) => ({ name, count: n })).sort((a, b) => b.count - a.count); };
  return {
    range, totalTickets: cur.length, ticketsChange: cur.length - prev.length,
    avgResolutionDays: avgDays, resolutionChangeDays: avgDays !== null && prevAvg !== null ? +(avgDays - prevAvg).toFixed(1) : null,
    totalRepairCostKobo: cost.materialsKobo + cost.laborKobo + cost.emergencyKobo,
    slaCompliance: resolved.length ? Math.round((onTime / resolved.length) * 100) : null,
    byCategory: count((m) => m.category), byProperty: count((m) => m.properties?.title ?? 'Property'), costBreakdown: cost,
  };
}
