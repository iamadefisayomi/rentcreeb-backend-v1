import { Router } from 'express';
import multer from 'multer';
import { createHash } from 'crypto';
import { z } from 'zod';
import { env } from '../config/env';
import { db } from '../lib/supabase';
import { badRequest, conflict, HttpError } from '../lib/errors';
import { boolish } from '../lib/common';
import { verifyNinWithSelfie } from '../lib/bytid';
import { uploadToBunny } from '../lib/bunny';
import { logger } from '../lib/logger';
import { authenticate } from '../middleware/auth';
import { notify } from '../services/notify';

const r = Router();
r.use(authenticate);
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 12 * 1024 * 1024 } });
const hashNin = (nin: string) => createHash('sha256').update(nin + env.OTP_PEPPER).digest('hex');

/** Failed tries that still count toward the limit (an admin can reset them: counts_as_attempt = false, migration 013). */
async function failedAttempts(userId: string) {
  const base = () => db.from('verifications').select('id', { count: 'exact', head: true }).eq('user_id', userId).eq('status', 'failed');
  const r = await base().eq('counts_as_attempt', true);
  if (!r.error) return r.count ?? 0;
  const { count } = await base(); // migration 013 not applied yet
  return count ?? 0;
}

/** Insert a verification row; drops the review-evidence columns if migration 013 hasn't been applied yet. */
async function insertVerification(row: Record<string, unknown>) {
  const { data, error } = await db.from('verifications').insert(row).select('id').single();
  if (!error) return data;
  if (/selfie_path|document_path|document_type|column/i.test(error.message)) {
    const { selfie_path: _s, document_path: _d, document_type: _t, ...rest } = row;
    const retry = await db.from('verifications').insert(rest).select('id').single();
    if (!retry.error) return retry.data;
  }
  throw error;
}

const IMAGE = /^image\/(jpeg|jpg|png|webp|heic|heif)$/i;
/** Keep a copy for a human reviewer, in the private zone. Deleted after the admin decides, or after 30 days. Never blocks the user. */
async function keepForReview(userId: string, file: Express.Multer.File | undefined, kind: 'selfie' | 'document') {
  if (!file) return null;
  if (kind === 'selfie' && !IMAGE.test(file.mimetype)) return null;
  try { return (await uploadToBunny(file.buffer, `verification/${userId}`, `${kind}-${file.originalname || 'image.jpg'}`, true, file.mimetype)).path; }
  catch (err) { logger.warn({ err, kind }, 'could not keep verification evidence for review'); return null; }
}

r.get('/status', async (req, res) => {
  const used = await failedAttempts(req.user.id);
  const { count: inReview } = await db.from('verifications').select('id', { count: 'exact', head: true }).eq('user_id', req.user.id).eq('status', 'manual_review');
  res.json({
    status: req.user.verification_status,
    inReview: (inReview ?? 0) > 0,
    access: { unverified: 'browse_only', partially_verified: 'limited_actions', verified: 'full_access' }[req.user.verification_status],
    attemptsUsed: used, attemptsRemaining: Math.max(0, env.NIN_MAX_ATTEMPTS - used),
  });
});

/**
 * multipart/form-data: nin, consent, selfie (image). The selfie is forwarded to Bytid. It is only kept (privately) when the
 * result needs a person to look at it (close match or mismatch), and deleted once an admin decides or after 30 days.
 */
r.post('/nin', upload.single('selfie'), async (req, res) => {
  const { nin, consent } = z.object({ nin: z.string().regex(/^\d{11}$/, 'NIN must be 11 digits'), consent: boolish }).parse(req.body);
  if (!consent) throw badRequest('Consent is required', 'CONSENT_REQUIRED');
  if (!req.file) throw badRequest('Selfie image is required', 'SELFIE_REQUIRED');
  if (req.user.nin_verified) throw conflict('Already verified', 'ALREADY_VERIFIED');

  const used = await failedAttempts(req.user.id);
  if (used >= env.NIN_MAX_ATTEMPTS)
    throw new HttpError(429, 'Maximum attempts reached', 'VERIFICATION_LOCKED', { suggestions: ['fix_issue', 'contact_support', 'manual_verification'] });

  const ninHash = hashNin(nin);
  const { data: dup } = await db.from('verifications').select('user_id').eq('nin_hash', ninHash).eq('status', 'success').maybeSingle();
  if (dup && dup.user_id !== req.user.id) throw conflict('This NIN is linked to another account', 'NIN_IN_USE');

  const record = { user_id: req.user.id, nin_hash: ninHash, nin_last3: nin.slice(-3) };
  try {
    const result = await verifyNinWithSelfie(nin, req.file.buffer.toString('base64'));
    // The NIMC name is kept so a reviewer can compare it with the name on the account (no other NIN data is stored).
    const meta = { face_match: (result.raw as any)?.face_match?.status, request_id: (result.raw as any)?.request_id,
      nimc_name: [result.firstName, result.lastName].filter(Boolean).join(' ') || undefined };
    if (!result.match || result.confidence < env.BYTID_MIN_CONFIDENCE) {
      const selfie_path = await keepForReview(req.user.id, req.file, 'selfie');
      // Close calls (old NIMC photo, poor light) go to a person instead of locking the user out.
      if (result.confidence >= env.BYTID_REVIEW_SCORE) {
        await insertVerification({ ...record, status: 'manual_review', confidence: result.confidence, failure_reason: 'FACE_BORDERLINE', metadata: meta, selfie_path });
        return res.status(202).json({ status: 'in_review', message: 'Your selfie was a close match. Our team will review it and confirm by email, usually within 24 hours.' });
      }
      await insertVerification({ ...record, status: 'failed', confidence: result.confidence, failure_reason: 'FACE_MISMATCH', metadata: meta, selfie_path });
      throw new HttpError(422, 'We could not match your selfie to your NIN record', 'FACE_MISMATCH', { attemptsRemaining: Math.max(0, env.NIN_MAX_ATTEMPTS - used - 1) });
    }
    await db.from('verifications').insert({ ...record, status: 'success', confidence: result.confidence, metadata: meta });
    await db.from('profiles').update({ nin_verified: true, updated_at: new Date().toISOString() }).eq('id', req.user.id);
    await notify(req.user.id, 'verified', 'Identity verified ✅', 'You now have full access to RentCreeb.');
    res.json({ status: 'verified', ninLast3: nin.slice(-3) });
  } catch (err) {
    // Only count NIN-not-found as a user attempt; provider outages shouldn't burn attempts.
    if (err instanceof HttpError && err.code === 'NIN_NOT_FOUND')
      await db.from('verifications').insert({ ...record, status: 'failed', failure_reason: 'NIN_NOT_FOUND' });
    throw err;
  }
});

/**
 * Ask a person to verify you (after failed tries, or when the automatic check is down). Reviewed in /admin.
 * JSON { note } still works; multipart can add: nin, selfie (image), document (photo/PDF of NIN slip, ID card or passport), documentType.
 * One open request per user: a new request updates the evidence on the open one.
 */
const DOC_TYPES = ['nin_slip', 'national_id', 'passport', 'drivers_licence', 'voters_card', 'other'] as const;
r.post('/manual-request', upload.fields([{ name: 'selfie', maxCount: 1 }, { name: 'document', maxCount: 1 }]), async (req, res) => {
  const b = z.object({
    note: z.string().max(500).optional(),
    nin: z.union([z.string().regex(/^\d{11}$/, 'NIN must be 11 digits'), z.literal('')]).optional().transform((v) => v || undefined),
    documentType: z.enum(DOC_TYPES).optional(),
  }).parse(req.body ?? {});
  if (req.user.nin_verified) throw conflict('Already verified', 'ALREADY_VERIFIED');
  const files = (req.files ?? {}) as Record<string, Express.Multer.File[]>;
  const doc = files.document?.[0];
  if (doc && !IMAGE.test(doc.mimetype) && doc.mimetype !== 'application/pdf') throw badRequest('The ID document must be a photo or PDF', 'BAD_FILE');

  if (b.nin) {
    const { data: dup } = await db.from('verifications').select('user_id').eq('nin_hash', hashNin(b.nin)).eq('status', 'success').maybeSingle();
    if (dup && dup.user_id !== req.user.id) throw conflict('This NIN is linked to another account', 'NIN_IN_USE');
  }
  const [selfie_path, document_path] = await Promise.all([keepForReview(req.user.id, files.selfie?.[0], 'selfie'), keepForReview(req.user.id, doc, 'document')]);
  const metadata = { note: b.note, requested_at: new Date().toISOString() };
  const { data: open } = await db.from('verifications').select('id, metadata').eq('user_id', req.user.id).eq('status', 'manual_review')
    .order('created_at', { ascending: false }).limit(1).maybeSingle();
  if (open) {
    const patch: Record<string, unknown> = { metadata: { ...((open.metadata as object) ?? {}), ...metadata } };
    if (b.nin) { patch.nin_hash = hashNin(b.nin); patch.nin_last3 = b.nin.slice(-3); }
    if (selfie_path) patch.selfie_path = selfie_path;
    if (document_path) { patch.document_path = document_path; patch.document_type = b.documentType ?? 'other'; }
    const { error } = await db.from('verifications').update(patch).eq('id', open.id);
    if (error) await db.from('verifications').update({ metadata: patch.metadata }).eq('id', open.id); // pre-013 schema
  } else {
    await insertVerification({
      user_id: req.user.id, status: 'manual_review', failure_reason: 'MANUAL_REQUEST', metadata,
      nin_hash: b.nin ? hashNin(b.nin) : 'manual:' + req.user.id, nin_last3: b.nin ? b.nin.slice(-3) : '---',
      selfie_path, document_path, document_type: document_path ? b.documentType ?? 'other' : null,
    });
  }
  res.status(202).json({ message: 'Request received. Our team will review it and let you know, usually within 24 hours.' });
});

export default r;
