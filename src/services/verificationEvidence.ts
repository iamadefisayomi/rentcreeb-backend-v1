import { db } from '../lib/supabase';
import { deleteFromBunny } from '../lib/bunny';
import { logger } from '../lib/logger';

/**
 * Delete the short-lived review evidence from the verifications matched by `scope`. Used once an admin decides, and by
 * the 30-day clean-up. What goes:
 *  - uploaded ID documents (manual review requests), and
 *  - selfies sent with a manual review request (rows with no NIN check result).
 *
 * The NIN check record is the identity record of the account and is KEPT, so admins can always see it on the ID
 * verification page, whatever the outcome: the full Bytid response, the NIMC ID photo it returned, AND the selfie the
 * user took for that check (rows with nimc_record set).
 * Pass `includeNimc: true` only to erase a person's identity data completely (e.g. a data-deletion request).
 */
export async function purgeVerificationEvidence(scope: (q: any) => any, opts: { includeNimc?: boolean; limit?: number } = {}) {
  const limit = opts.limit ?? 500;
  if (!opts.includeNimc) {
    // Only rows that still hold something deletable, so kept NIN-check selfies never clog the batch.
    const { data, error } = await scope(db.from('verifications').select('id, selfie_path, document_path, nimc_record'))
      .or('document_path.not.is.null,and(selfie_path.not.is.null,nimc_record.is.null)').limit(limit);
    if (error) { logger.warn({ err: error.message }, 'verification evidence purge: query failed'); return; }
    for (const v of data ?? []) {
      const keepSelfie = v.nimc_record != null;
      const paths = [keepSelfie ? null : v.selfie_path, v.document_path].filter(Boolean);
      for (const p of paths) await deleteFromBunny(p, true);
      await db.from('verifications').update(keepSelfie ? { document_path: null } : { selfie_path: null, document_path: null }).eq('id', v.id);
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
