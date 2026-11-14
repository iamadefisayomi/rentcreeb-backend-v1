import { db } from '../lib/supabase';
import { fullName } from '../lib/common';
import { notify } from './notify';
import { sendSms } from '../lib/sms';
import { sendEmail } from '../lib/email';

/** Columns every landlord/tenant tenancy view needs. */
export const TENANCY_SELECT =
  '*, properties(id, title, address, area), units(id, label, unit_type, rent_kobo), ' +
  'tenant:profiles!tenancies_tenant_id_fkey(id, first_name, last_name, phone, email, avatar_url, nin_verified), ' +
  'rent_payments(id, amount_kobo, due_date, status, paid_at, method, reference), ' +
  'lease_renewals(id, new_lease_end, new_rent_kobo, status, created_at), rent_reminders(created_at)';

export type TenancyState = 'invited' | 'active' | 'overdue' | 'expiring' | 'vacating' | 'ended';
const DAY = 864e5;
const today = () => new Date().toISOString().slice(0, 10);
const days = (a: string, b: string) => Math.round((new Date(a).getTime() - new Date(b).getTime()) / DAY);

/** Flattens a tenancy row (with TENANCY_SELECT embeds) into what the app screens show. */
export function tenancyView(t: any) {
  const now = today();
  const pays = [...(t.rent_payments ?? [])].sort((a: any, b: any) => a.due_date.localeCompare(b.due_date));
  const unpaid = pays.filter((p: any) => p.status !== 'paid');
  const overdue = unpaid.filter((p: any) => p.due_date < now);
  const nextDue = unpaid[0] ?? null;
  const lastPaid = [...pays].filter((p: any) => p.status === 'paid').sort((a: any, b: any) => (b.paid_at ?? '').localeCompare(a.paid_at ?? ''))[0] ?? null;
  const end = t.terminates_on ?? t.lease_end;
  const daysRemaining = end ? Math.max(0, days(end, now)) : null;
  const totalDays = end ? Math.max(1, days(end, t.lease_start)) : null;
  const reminders = [...(t.rent_reminders ?? [])].sort((a: any, b: any) => b.created_at.localeCompare(a.created_at));
  const renewal = (t.lease_renewals ?? []).find((r: any) => r.status === 'pending') ?? null;

  const state: TenancyState =
    t.status === 'ended' ? 'ended'
      : t.terminates_on ? 'vacating'
      : !t.tenant_id ? 'invited'
      : overdue.length ? 'overdue'
      : t.lease_end && days(t.lease_end, now) <= 60 ? 'expiring'
      : 'active';

  return {
    id: t.id, status: t.status, state,
    tenant: t.tenant ? { id: t.tenant.id, name: fullName(t.tenant), phone: t.tenant.phone, email: t.tenant.email, avatarUrl: t.tenant.avatar_url, verified: !!t.tenant.nin_verified } : null,
    invite: t.tenant_id ? null : { name: t.invite_name, email: t.invite_email, phone: t.invite_phone },
    displayName: t.tenant ? fullName(t.tenant) : (t.invite_name ?? t.invite_email ?? t.invite_phone ?? 'Invited tenant'),
    property: t.properties ? { id: t.properties.id, title: t.properties.title, address: t.properties.address, area: t.properties.area } : null,
    unit: t.units ? { id: t.units.id, label: t.units.label, type: t.units.unit_type } : (t.unit_label ? { id: null, label: t.unit_label, type: null } : null),
    rentKobo: Number(t.rent_kobo), frequency: t.frequency,
    leaseStart: t.lease_start, leaseEnd: t.lease_end, daysRemaining,
    leaseProgress: totalDays && daysRemaining !== null ? Math.min(100, Math.max(0, Math.round(((totalDays - daysRemaining) / totalDays) * 100))) : null,
    nextDue: nextDue ? { id: nextDue.id, dueDate: nextDue.due_date, amountKobo: Number(nextDue.amount_kobo), status: nextDue.status } : null,
    overdueKobo: overdue.reduce((s: number, p: any) => s + Number(p.amount_kobo), 0),
    overdueDays: overdue.length ? days(now, overdue[0].due_date) : 0,
    lastPayment: lastPaid ? { amountKobo: Number(lastPaid.amount_kobo), paidAt: lastPaid.paid_at, method: lastPaid.method } : null,
    emergencyContact: t.emergency_contact_name || t.emergency_contact_phone ? { name: t.emergency_contact_name, phone: t.emergency_contact_phone } : null,
    notice: t.terminates_on ? { givenAt: t.notice_given_at, days: t.notice_days, terminatesOn: t.terminates_on, reason: t.termination_reason } : null,
    pendingRenewal: renewal ? { id: renewal.id, newLeaseEnd: renewal.new_lease_end, newRentKobo: Number(renewal.new_rent_kobo), sentAt: renewal.created_at } : null,
    lastRemindedAt: reminders[0]?.created_at ?? null,
  };
}

/** Fills {name} {amount} {due_date} {unit} in a reminder template for one tenancy. */
export function renderReminder(template: string, v: ReturnType<typeof tenancyView>) {
  const amount = v.overdueKobo || v.nextDue?.amountKobo || v.rentKobo;
  const due = v.nextDue?.dueDate ? new Date(v.nextDue.dueDate).toLocaleDateString('en-NG', { day: 'numeric', month: 'short', year: 'numeric' }) : '—';
  return template
    .replace(/\{name\}/g, v.displayName.split(' ')[0])
    .replace(/\{amount\}/g, `₦${(amount / 100).toLocaleString('en-NG')}`)
    .replace(/\{due_date\}/g, due)
    .replace(/\{unit\}/g, v.unit ? `${v.unit.label}${v.property ? `, ${v.property.title}` : ''}` : (v.property?.title ?? 'your unit'));
}

export const DEFAULT_REMINDER =
  'Dear {name}, your rent of {amount} for {unit} was due on {due_date}. Please make payment as soon as possible to avoid penalties.';

/** Sends one reminder on each requested channel and records it. Returns the channels actually used. */
export async function sendRentReminder(t: any, landlordId: string, template: string, channels: ('in_app' | 'sms' | 'email')[]) {
  const v = tenancyView(t);
  const msg = renderReminder(template, v);
  const phone = v.tenant?.phone ?? v.invite?.phone; const email = v.tenant?.email ?? v.invite?.email;
  const used: string[] = [];
  for (const ch of channels) {
    if (ch === 'in_app' && v.tenant) { await notify(v.tenant.id, 'rent_reminder', 'Rent reminder', msg, { tenancyId: t.id }); used.push(ch); }
    if (ch === 'sms' && phone) { await sendSms(phone, `RentCreeb: ${msg}`); used.push(ch); }
    if (ch === 'email' && email) { await sendEmail(email, 'Rent reminder', `<p>${msg.replace(/</g, '&lt;')}</p><p>— Sent via RentCreeb</p>`); used.push(ch); }
  }
  if (used.length) await db.from('rent_reminders').insert(used.map((channel) => ({ tenancy_id: t.id, landlord_id: landlordId, channel, message: msg })));
  return used;
}
