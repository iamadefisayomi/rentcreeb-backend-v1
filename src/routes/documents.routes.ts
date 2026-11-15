import { Router } from 'express';
import { z } from 'zod';
import { db, dbError, unwrap } from '../lib/supabase';
import { badRequest, forbidden, notFound } from '../lib/errors';
import { signPrivateUrl } from '../lib/bunny';
import { authenticate } from '../middleware/auth';
import { notify } from '../services/notify';
import { fullName } from '../lib/common';

/**
 * Personal document storage (leases, IDs, receipts, utility bills, letters).
 * Files live in the private storage zone (POST /uploads?folder=user-docs) and are only ever handed out as
 * short-lived signed links. A tenant can share a document with the landlord of one of their tenancies.
 */
const r = Router();
r.use(authenticate);

const CATEGORY = z.enum(['lease', 'id', 'receipt', 'utility', 'letter', 'other']);
const LINK_TTL = 10 * 60;

/** The tenancy must be the caller's own (as tenant) to share a document into it. */
async function ownTenancy(tenancyId: string, userId: string) {
  const { data } = await db.from('tenancies').select('id, tenant_id, landlord_id').eq('id', tenancyId).maybeSingle();
  if (!data || data.tenant_id !== userId) throw badRequest('You can only share with a landlord of your own tenancy', 'BAD_TENANCY');
  return data;
}

r.get('/', async (req, res) => {
  const { data, error } = await db.from('user_documents').select('*, tenancies(id, unit_label, properties(title))').eq('user_id', req.user.id).order('created_at', { ascending: false });
  if (error) throw dbError(error);
  res.json({ documents: data });
});

r.post('/', async (req, res) => {
  const b = z.object({
    title: z.string().trim().min(2).max(120), category: CATEGORY.default('other'),
    path: z.string().startsWith(`user-docs/${req.user.id}/`).max(500), mimeType: z.string().max(120).optional(), sizeBytes: z.number().int().min(0).max(50 * 1024 * 1024).optional(),
    tenancyId: z.string().uuid().optional(), shareWithLandlord: z.boolean().default(false),
  }).parse(req.body);
  const t = b.tenancyId ? await ownTenancy(b.tenancyId, req.user.id) : null;
  if (b.shareWithLandlord && !t) throw badRequest('Choose the tenancy to share with', 'BAD_TENANCY');
  const doc = unwrap(await db.from('user_documents').insert({
    user_id: req.user.id, tenancy_id: t?.id ?? null, category: b.category, title: b.title, storage_path: b.path,
    mime_type: b.mimeType ?? null, size_bytes: b.sizeBytes ?? null, shared_with_landlord: b.shareWithLandlord,
  }).select().single());
  if (b.shareWithLandlord && t) await notify(t.landlord_id, 'tenancy_update', 'New document shared', `${fullName(req.user) || 'Your tenant'} shared “${b.title}”`, { tenancyId: t.id });
  res.status(201).json({ document: doc });
});

r.patch('/:id', async (req, res) => {
  const b = z.object({ title: z.string().trim().min(2).max(120).optional(), category: CATEGORY.optional(), tenancyId: z.string().uuid().nullable().optional(), shareWithLandlord: z.boolean().optional() }).parse(req.body);
  const { data: doc } = await db.from('user_documents').select('*').eq('id', req.params.id).maybeSingle();
  if (!doc || doc.user_id !== req.user.id) throw notFound('Document not found');
  const tenancyId = b.tenancyId === undefined ? doc.tenancy_id : b.tenancyId;
  const t = tenancyId ? await ownTenancy(tenancyId, req.user.id) : null;
  const share = b.shareWithLandlord ?? doc.shared_with_landlord;
  if (share && !t) throw badRequest('Choose the tenancy to share with', 'BAD_TENANCY');
  const updated = unwrap(await db.from('user_documents').update({
    title: b.title ?? doc.title, category: b.category ?? doc.category, tenancy_id: t?.id ?? null, shared_with_landlord: share,
  }).eq('id', doc.id).select().single());
  if (share && !doc.shared_with_landlord && t) await notify(t.landlord_id, 'tenancy_update', 'New document shared', `${fullName(req.user) || 'Your tenant'} shared “${updated.title}”`, { tenancyId: t.id });
  res.json({ document: updated });
});

r.delete('/:id', async (req, res) => {
  const { data } = await db.from('user_documents').delete().eq('id', req.params.id).eq('user_id', req.user.id).select('id').maybeSingle();
  if (!data) throw notFound('Document not found');
  res.status(204).end();
});

/** Short-lived link to open a document: the owner, or the landlord of the tenancy it is shared with. */
r.get('/:id/url', async (req, res) => {
  const { data: doc } = await db.from('user_documents').select('id, user_id, tenancy_id, shared_with_landlord, storage_path').eq('id', req.params.id).maybeSingle();
  if (!doc) throw notFound('Document not found');
  if (doc.user_id !== req.user.id) {
    if (!doc.shared_with_landlord || !doc.tenancy_id) throw forbidden();
    const { data: t } = await db.from('tenancies').select('landlord_id').eq('id', doc.tenancy_id).maybeSingle();
    if (t?.landlord_id !== req.user.id) throw forbidden();
  }
  res.json({ url: signPrivateUrl(doc.storage_path, LINK_TTL), expiresIn: LINK_TTL });
});

export default r;
