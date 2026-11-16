import { db } from '../lib/supabase';
import { badRequest, conflict } from '../lib/errors';

/**
 * Deactivates and anonymises an account rather than hard-deleting it, so payments, tenancies, bookings and reviews
 * that other users depend on stay intact. Sign-in is blocked by banning the auth user.
 * Used by Settings → Delete Account and by admins handling data-deletion requests.
 */
export async function closeAccount(uid: string, opts: { force?: boolean } = {}) {
  const [wallet, bookings] = await Promise.all([
    db.from('wallets').select('available_kobo').eq('user_id', uid).maybeSingle(),
    db.from('bookings').select('id', { count: 'exact', head: true }).or(`tenant_id.eq.${uid},host_id.eq.${uid}`).in('status', ['paid', 'confirmed']),
  ]);
  if (!opts.force && Number(wallet.data?.available_kobo ?? 0) > 0) throw conflict('Withdraw your wallet balance before deleting your account', 'BALANCE_REMAINING');
  if (!opts.force && (bookings.count ?? 0) > 0) throw conflict('You have upcoming inspections. Complete or cancel them first.', 'ACTIVE_BOOKINGS');

  await db.from('properties').update({ status: 'archived' }).eq('owner_id', uid).neq('status', 'archived');
  await db.from('profiles').update({
    first_name: 'Deleted', last_name: 'User', email: null, phone: null, avatar_url: null, bio: null, username: null,
    gender: null, date_of_birth: null, agency_name: null, license_number: null, location: null, expo_push_token: null,
    is_suspended: true, deleted_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  }).eq('id', uid);
  const { error } = await db.auth.admin.updateUserById(uid, { email: `deleted+${uid}@users.invalid`, ban_duration: '876000h', user_metadata: {} });
  if (error) throw badRequest(error.message);
}
