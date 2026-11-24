import { db } from '../lib/supabase';
import { conflict } from '../lib/errors';
import { logger } from '../lib/logger';

const CLAIMED = 'NIN_CLAIMED_ELSEWHERE';

/** Mark rows failed without counting against their owner; drops counts_as_attempt on a pre-013 schema. */
async function closeRows(ids: string[]) {
  if (!ids.length) return;
  const patch = { status: 'failed', failure_reason: CLAIMED, counts_as_attempt: false };
  const r = await db.from('verifications').update(patch).in('id', ids);
  if (r.error && /column/i.test(r.error.message)) {
    const { counts_as_attempt: _c, ...rest } = patch;
    await db.from('verifications').update(rest).in('id', ids);
  } else if (r.error) logger.warn({ err: r.error.message }, 'could not close other claims on a NIN');
}

/**
 * A NIN can belong to only one VERIFIED account. Rejects if another account that is verified right now holds it.
 * A claim by an account that is not verified (a pending review, a failed try, or a stale "success" left behind after a
 * revoke) does not block: stale successes are closed here so the one-NIN unique index lets this account through.
 */
export async function assertNinAvailable(ninHash: string, userId: string) {
  const { data } = await db.from('verifications').select('id, user_id').eq('nin_hash', ninHash).eq('status', 'success').neq('user_id', userId);
  const rows = data ?? [];
  if (!rows.length) return;
  const { data: owners } = await db.from('profiles').select('id, nin_verified').in('id', [...new Set(rows.map((r) => r.user_id))]);
  if ((owners ?? []).some((p) => p.nin_verified)) throw conflict('This NIN is linked to another verified account', 'NIN_IN_USE');
  await closeRows(rows.map((r) => r.id));
}

/** After this account is verified with the NIN, other accounts' open reviews for the same NIN are overridden. */
export async function releaseOtherClaims(ninHash: string, userId: string) {
  const { data } = await db.from('verifications').select('id').eq('nin_hash', ninHash).eq('status', 'manual_review').neq('user_id', userId);
  await closeRows((data ?? []).map((r) => r.id));
}
