import { db } from '../lib/supabase';
import { deleteFromBunny } from '../lib/bunny';
import { logger } from '../lib/logger';

/**
 * Delete the ID evidence kept for admin review (selfie, ID document, the NIN response and the NIMC pictures) from the
 * verifications matched by `scope`. Used once an admin decides, and by the 30-day clean-up.
 * Works before migration 017 (no nimc_* columns) by falling back to the selfie/document columns.
 */
export async function purgeVerificationEvidence(scope: (q: any) => any, limit = 500) {
  let rows: any[] = [];
  let full = true;
  const r1 = await scope(db.from('verifications').select('id, selfie_path, document_path, nimc_files, nimc_record'))
    .or('selfie_path.not.is.null,document_path.not.is.null,nimc_files.not.is.null,nimc_record.not.is.null').limit(limit);
  if (r1.error) {
    full = false;
    const r2 = await scope(db.from('verifications').select('id, selfie_path, document_path')).or('selfie_path.not.is.null,document_path.not.is.null').limit(limit);
    if (r2.error) { logger.warn({ err: r2.error.message }, 'verification evidence purge: query failed'); return; }
    rows = r2.data ?? [];
  } else rows = r1.data ?? [];
  for (const v of rows) {
    const paths = [v.selfie_path, v.document_path, ...((Array.isArray(v.nimc_files) ? v.nimc_files : []).map((f: any) => f?.path))].filter(Boolean);
    for (const p of paths) await deleteFromBunny(p, true);
    await db.from('verifications').update(full ? { selfie_path: null, document_path: null, nimc_files: null, nimc_record: null } : { selfie_path: null, document_path: null }).eq('id', v.id);
  }
}
