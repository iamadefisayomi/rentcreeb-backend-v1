import { db } from '../lib/supabase';
import { deleteFromBunny } from '../lib/bunny';
import { logger } from '../lib/logger';

/**
 * Delete the short-lived review evidence (the user's selfie and any uploaded ID document) from the verifications matched
 * by `scope`. Used once an admin decides, and by the 30-day clean-up.
 *
 * The NIMC record (the ID card / photo returned by the NIN check, and the full NIN response) is the identity record of
 * the account and is KEPT, so admins can always see it on the ID verification page, whatever the outcome.
 * Pass `includeNimc: true` only to erase a person's identity data completely (e.g. a data-deletion request).
 */
export async function purgeVerificationEvidence(scope: (q: any) => any, opts: { includeNimc?: boolean; limit?: number } = {}) {
  const limit = opts.limit ?? 500;
  if (!opts.includeNimc) {
    const { data, error } = await scope(db.from('verifications').select('id, selfie_path, document_path'))
      .or('selfie_path.not.is.null,document_path.not.is.null').limit(limit);
    if (error) { logger.warn({ err: error.message }, 'verification evidence purge: query failed'); return; }
    for (const v of data ?? []) {
      for (const p of [v.selfie_path, v.document_path].filter(Boolean)) await deleteFromBunny(p, true);
      await db.from('verifications').update({ selfie_path: null, document_path: null }).eq('id', v.id);
    }
    return;
  }
  const { data, error } = await scope(db.from('verifications').select('id, selfie_path, document_path, nimc_files, nimc_record'))
    .or('selfie_path.not.is.null,document_path.not.is.null,nimc_files.not.is.null,nimc_record.not.is.null').limit(limit);
  if (error) { logger.warn({ err: error.message }, 'verification evidence purge (full): query failed'); return; }
  for (const v of data ?? []) {
    const paths = [v.selfie_path, v.document_path, ...((Array.isArray(v.nimc_files) ? v.nimc_files : []).map((f: any) => f?.path))].filter(Boolean);
    for (const p of paths) await deleteFromBunny(p, true);
    await db.from('verifications').update({ selfie_path: null, document_path: null, nimc_files: null, nimc_record: null }).eq('id', v.id);
  }
}
