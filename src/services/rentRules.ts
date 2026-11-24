import { db } from '../lib/supabase';
import { logger } from '../lib/logger';
import { notify } from './notify';

/**
 * Landlord rent rules (migration 034): an automatic reminder schedule and an optional late fee.
 * Runs once a day from the scheduler. Every reminder is logged per rent payment and tag, so nothing is sent twice.
 * Without migration 034 it falls back to the old single "due in 3 days" reminder.
 */
export type RentSettings = {
  reminders_enabled: boolean; remind_days_before: number[]; remind_on_due_day: boolean; remind_days_after: number[];
  late_fee_enabled: boolean; late_fee_type: 'percent' | 'fixed'; late_fee_value: number; late_fee_grace_days: number;
};
export const DEFAULT_RENT_SETTINGS: RentSettings = {
  reminders_enabled: true, remind_days_before: [7, 3, 1], remind_on_due_day: true, remind_days_after: [1, 7],
  late_fee_enabled: false, late_fee_type: 'percent', late_fee_value: 5, late_fee_grace_days: 7,
};

const day = (offset: number) => new Date(Date.now() + offset * 864e5).toISOString().slice(0, 10);
const naira = (k: number) => `₦${Math.round(k / 100).toLocaleString('en-NG')}`;
const daysBetween = (a: string, b: string) => Math.round((new Date(b + 'T12:00:00Z').getTime() - new Date(a + 'T12:00:00Z').getTime()) / 864e5);

export async function settingsFor(landlordId: string): Promise<RentSettings> {
  const { data } = await db.from('rent_settings').select('*').eq('landlord_id', landlordId).maybeSingle();
  return { ...DEFAULT_RENT_SETTINGS, ...(data ?? {}), late_fee_value: Number(data?.late_fee_value ?? DEFAULT_RENT_SETTINGS.late_fee_value) };
}

/** The fee for one overdue rent: percent of the rent, or a fixed amount (stored in kobo). */
export const lateFeeFor = (s: RentSettings, rentKobo: number) =>
  Math.max(0, Math.round(s.late_fee_type === 'percent' ? (rentKobo * s.late_fee_value) / 100 : s.late_fee_value));

/** Returns false when this tag was already sent for this payment. */
async function claim(rentPaymentId: string, tag: string) {
  const { error } = await db.from('rent_reminder_log').insert({ rent_payment_id: rentPaymentId, tag });
  return !error;
}

export async function runRentReminders() {
  const probe = await db.from('rent_settings').select('landlord_id').limit(1);
  if (probe.error) return legacyReminder();

  const today = day(0);
  // Unpaid rent from 30 days back to 30 days ahead covers every possible schedule.
  const { data, error } = await db.from('rent_payments')
    .select('id, amount_kobo, due_date, status, late_fee_kobo, tenancies(id, tenant_id, landlord_id, status)')
    .in('status', ['due', 'overdue']).gte('due_date', day(-90)).lte('due_date', day(30)).limit(5000);
  if (error) { logger.error({ err: error.message }, 'rent reminders: query failed'); return; }

  const cache = new Map<string, RentSettings>();
  for (const rp of (data ?? []) as any[]) {
    const t = rp.tenancies;
    if (!t?.tenant_id || t.status !== 'active') continue;
    let s = cache.get(t.landlord_id);
    if (!s) { s = await settingsFor(t.landlord_id); cache.set(t.landlord_id, s); }
    const diff = daysBetween(today, rp.due_date); // >0: days until due, <0: days late
    const amount = Number(rp.amount_kobo);

    try {
      // Late fee once, after the grace period.
      if (s.late_fee_enabled && diff < 0 && -diff >= s.late_fee_grace_days && !Number(rp.late_fee_kobo)) {
        const fee = lateFeeFor(s, amount);
        if (fee > 0 && await claim(rp.id, 'late_fee')) {
          const { data: upd } = await db.from('rent_payments').update({ amount_kobo: amount + fee, late_fee_kobo: fee, late_fee_applied_at: new Date().toISOString() })
            .eq('id', rp.id).in('status', ['due', 'overdue']).eq('late_fee_kobo', 0).select('id').maybeSingle();
          if (upd) {
            await notify(t.tenant_id, 'late_fee', 'Late fee added', `Rent due on ${rp.due_date} is ${-diff} days late. A ${naira(fee)} late fee was added; ${naira(amount + fee)} is now due.`, { tenancyId: t.id });
            await notify(t.landlord_id, 'late_fee', 'Late fee applied', `A ${naira(fee)} late fee was added to rent that is ${-diff} days overdue.`, { tenancyId: t.id });
          }
        }
        continue;
      }
      if (!s.reminders_enabled) continue;
      let tag: string | null = null; let title = ''; let body = '';
      if (diff > 0 && s.remind_days_before.includes(diff)) {
        tag = `before:${diff}`; title = diff === 1 ? 'Rent due tomorrow' : `Rent due in ${diff} days`;
        body = `${naira(amount)} is due on ${rp.due_date}. Pay in the app to get an instant receipt.`;
      } else if (diff === 0 && s.remind_on_due_day) {
        tag = 'due'; title = 'Rent is due today'; body = `${naira(amount)} is due today.`;
      } else if (diff < 0 && s.remind_days_after.includes(-diff)) {
        tag = `after:${-diff}`; title = 'Rent is overdue';
        const feeNote = s.late_fee_enabled && !Number(rp.late_fee_kobo) && -diff < s.late_fee_grace_days
          ? ` A late fee of ${naira(lateFeeFor(s, amount))} applies after ${s.late_fee_grace_days} days.` : '';
        body = `${naira(amount)} was due on ${rp.due_date}.${feeNote}`;
      }
      if (tag && await claim(rp.id, tag)) await notify(t.tenant_id, 'rent_reminder', title, body, { tenancyId: t.id });
    } catch (err) { logger.warn({ err, rentPaymentId: rp.id }, 'rent reminder failed'); }
  }
}

/** Before migration 034: the original single reminder, 3 days before. */
async function legacyReminder() {
  const d = day(3);
  const { data } = await db.from('rent_payments').select('amount_kobo, tenancies(tenant_id, id)').eq('status', 'due').eq('due_date', d);
  for (const rp of (data ?? []) as any[]) {
    if (!rp.tenancies?.tenant_id) continue;
    await notify(rp.tenancies.tenant_id, 'rent_reminder', 'Rent due in 3 days', `₦${(rp.amount_kobo / 100).toLocaleString()} is due on ${d}.`, { tenancyId: rp.tenancies.id });
  }
}
