import type { Router } from 'express';
import { z } from 'zod';
import { db, dbError } from '../../lib/supabase';
import { notFound } from '../../lib/errors';
import { paginate, uuid } from '../../lib/common';
import { notify } from '../../services/notify';
import { audit, count, PERSON } from './shared';

/** Admin → Scam alerts: warnings raised in chats by services/scamGuard.ts (migration 024). */
const STATUSES = ['open', 'reported', 'dismissed', 'confirmed', 'cleared'] as const;

export function mountScam(r: Router) {
  r.get('/scam-alerts', async (req, res) => {
    const { from, to } = paginate(req.query);
    const { tab } = z.object({ tab: z.enum(['todo', 'all', ...STATUSES]).default('todo') }).parse(req.query);
    let q = db.from('scam_alerts').select(`*, suspect:profiles!scam_alerts_suspect_id_fkey(${PERSON}, is_suspended), recipient:profiles!scam_alerts_recipient_id_fkey(${PERSON})`, { count: 'exact' })
      .order('created_at', { ascending: false }).range(from, to);
    if (tab === 'todo') q = q.in('status', ['open', 'reported']);
    else if (tab !== 'all') q = q.eq('status', tab);
    const { data, count: total, error } = await q;
    if (error) {
      if (/scam_alerts/.test(error.message)) return res.json({ alerts: [], total: 0, missing: true, counts: {} });
      throw dbError(error);
    }
    // How often each suspect has been flagged (repeat offenders stand out).
    const ids = [...new Set((data ?? []).map((a: any) => a.suspect_id).filter(Boolean))];
    const priors: Record<string, number> = {};
    if (ids.length) {
      const { data: all } = await db.from('scam_alerts').select('suspect_id').in('suspect_id', ids).limit(5000);
      for (const x of (all ?? []) as any[]) priors[x.suspect_id] = (priors[x.suspect_id] ?? 0) + 1;
    }
    const [open, reported] = await Promise.all([count('scam_alerts', (x) => x.eq('status', 'open')), count('scam_alerts', (x) => x.eq('status', 'reported'))]);
    res.json({ alerts: (data ?? []).map((a: any) => ({ ...a, suspectAlertCount: priors[a.suspect_id] ?? 0 })), total: total ?? 0, counts: { open, reported } });
  });

  /** confirmed = it was a scam (the recipient is told); cleared = false alarm (warning removed). */
  r.patch('/scam-alerts/:id', async (req, res) => {
    const id = uuid.parse(req.params.id);
    const b = z.object({ status: z.enum(['confirmed', 'cleared', 'open']), note: z.string().trim().max(1000).optional(), tellRecipient: z.boolean().default(true) }).parse(req.body);
    const { data: a } = await db.from('scam_alerts').select('id, conversation_id, recipient_id, admin_note').eq('id', id).maybeSingle();
    if (!a) throw notFound('Alert not found');
    const { error } = await db.from('scam_alerts').update({
      status: b.status, reviewed_by: req.user.id, reviewed_at: new Date().toISOString(),
      ...(b.note ? { admin_note: [a.admin_note, `Admin: ${b.note}`].filter(Boolean).join('\n') } : {}),
    }).eq('id', id);
    if (error) throw dbError(error);
    if (b.status === 'confirmed' && b.tellRecipient) {
      await notify(a.recipient_id, 'scam_alert', '🚫 Confirmed scam attempt', 'Our team reviewed this chat and confirmed it was a scam attempt. Do not send money or details to this person.', { conversationId: a.conversation_id });
    }
    await audit(req, `scam_alert.${b.status}`, 'scam_alert', id, b.note ? { note: b.note } : {});
    res.json({ ok: true });
  });
}
