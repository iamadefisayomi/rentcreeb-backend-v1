import cron from 'node-cron';
import { db } from '../lib/supabase';
import { logger } from '../lib/logger';
import { notify } from '../services/notify';
import { purgeVerificationEvidence } from '../services/verificationEvidence';
import { reviewPendingListings } from '../services/listingReview';
import { processMailQueue } from '../services/mailing';

/**
 * Housekeeping. If you run multiple API instances, run this on ONE instance
 * (or move to Supabase pg_cron / a worker) so jobs don't fire twice.
 */
export function startScheduler() {
  // Every minute: AI + rule review of listings waiting for approval (auto-approves the ones that fully pass).
  cron.schedule('* * * * *', () => { void reviewPendingListings(); });

  // Every minute: mailing list queue (scheduled campaigns, automations, rate-limited delivery).
  cron.schedule('* * * * *', () => { void processMailQueue(); });

  // Every 10 min: expire unpaid bookings and stale OTPs. An unpaid booking can be paid later from My Bookings or the
  // property page for up to 24 hours, but never closer than 2 hours to the inspection (same rule as booking it).
  cron.schedule('*/10 * * * *', async () => {
    try {
      const cutoff = new Date(Date.now() - 24 * 3600000).toISOString();
      const tooLate = new Date(Date.now() + 2 * 3600000).toISOString();
      await db.from('bookings').update({ status: 'expired' }).eq('status', 'pending_payment').or(`created_at.lt.${cutoff},scheduled_at.lt.${tooLate}`);
      await db.from('otp_codes').delete().lt('expires_at', new Date(Date.now() - 86400000).toISOString());
    } catch (err) { logger.error({ err }, 'cron: bookings/otp cleanup failed'); }
  });

  // Hourly: expire subscriptions (listings get hidden by the search query) and flag overdue rent.
  cron.schedule('0 * * * *', async () => {
    try {
      const { data: expired } = await db.from('subscriptions').update({ status: 'expired' }).eq('status', 'active').lt('expires_at', new Date().toISOString()).select('agent_id');
      for (const s of expired ?? []) await notify(s.agent_id, 'subscription_expired', 'Subscription expired', 'Renew your plan to make your listings visible again.');
      await db.from('rent_payments').update({ status: 'overdue' }).eq('status', 'due').lt('due_date', new Date().toISOString().slice(0, 10));
    } catch (err) { logger.error({ err }, 'cron: subscriptions/rent failed'); }
  });

  // Daily 8am (Lagos = UTC+1 → 07:00 UTC): rent due in 3 days.
  cron.schedule('0 7 * * *', async () => {
    try {
      const d = new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10);
      const { data } = await db.from('rent_payments').select('amount_kobo, tenancies(tenant_id, id)').eq('status', 'due').eq('due_date', d);
      for (const rp of (data ?? []) as any[]) {
        if (!rp.tenancies?.tenant_id) continue; // invited tenant hasn't joined yet
        await notify(rp.tenancies.tenant_id, 'rent_reminder', 'Rent due in 3 days', `₦${(rp.amount_kobo / 100).toLocaleString()} is due on ${d}.`, { tenancyId: rp.tenancies.id });
      }
    } catch (err) { logger.error({ err }, 'cron: rent reminders failed'); }

    // Leases whose termination notice has run out end today; their unit becomes vacant.
    try {
      const today = new Date().toISOString().slice(0, 10);
      const { data: ending } = await db.from('tenancies').update({ status: 'ended' }).eq('status', 'active').lte('terminates_on', today).select('id, unit_id, tenant_id, landlord_id');
      for (const t of ending ?? []) {
        if (t.unit_id) await db.from('units').update({ status: 'vacant' }).eq('id', t.unit_id);
        await db.from('rent_payments').delete().eq('tenancy_id', t.id).eq('status', 'due');
        await notify(t.landlord_id, 'tenancy_update', 'Lease ended', 'A notice period finished today and the unit is now vacant.', { tenancyId: t.id });
        if (t.tenant_id) await notify(t.tenant_id, 'tenancy_update', 'Your lease has ended', 'Your notice period finished today.', { tenancyId: t.id });
      }
    } catch (err) { logger.error({ err }, 'cron: lease terminations failed'); }

    // Selfies and uploaded ID documents kept for admin review are deleted 30 days after the check, unless still being
    // reviewed. The NIMC card and NIN response are kept (see purgeVerificationEvidence).
    try {
      const cutoff = new Date(Date.now() - 30 * 86400000).toISOString();
      await purgeVerificationEvidence((q) => q.neq('status', 'manual_review').lt('created_at', cutoff));
    } catch (err) { logger.error({ err }, 'cron: verification evidence purge failed'); }
  });
}
