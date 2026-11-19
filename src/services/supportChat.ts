import { db, unwrap } from '../lib/supabase';
import { logger } from '../lib/logger';
import { sendEmail } from '../lib/email';
import { env } from '../config/env';
import { notify } from './notify';
import { conflict } from '../lib/errors';

/**
 * Support tickets live as chat threads (migration 018): a conversation with context_type 'support' whose context_id is
 * the ticket. The user is participant_a; any admin can answer (participant_b stays empty), and the app shows their
 * messages as "RentCreeb Support". A closed ticket closes the thread: nobody can post in it any more.
 */
export const SUPPORT_PERSON = { id: 'support', first_name: 'RentCreeb', last_name: 'Support', avatar_url: null as string | null, role: 'admin', nin_verified: true };

export type Ticket = {
  id: string; user_id: string; kind: string; category: string; subject: string; message: string; status: string;
  conversation_id?: string | null; created_at: string; closed_at?: string | null;
};

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

/** The ticket's thread, created on first use. The user's original message becomes its first message. */
export async function ensureTicketConversation(t: Ticket): Promise<string> {
  if (t.conversation_id) return t.conversation_id;
  const find = async () => (await db.from('conversations').select('id').eq('context_type', 'support').eq('context_id', t.id).limit(1).maybeSingle()).data?.id as string | undefined;
  let id = await find();
  if (!id) {
    const { data, error } = await db.from('conversations')
      .insert({ context_type: 'support', context_id: t.id, participant_a: t.user_id, participant_b: null, created_at: t.created_at, closed_at: t.status === 'closed' ? (t.closed_at ?? new Date().toISOString()) : null })
      .select('id').single();
    id = data?.id ?? (await find());
    if (!id) throw new Error(`could not create support conversation: ${error?.message}`);
    if (data) await db.from('messages').insert({ conversation_id: id, sender_id: t.user_id, body: `${t.subject}\n\n${t.message}`, created_at: t.created_at, read_at: t.created_at });
  }
  await db.from('support_tickets').update({ conversation_id: id }).eq('id', t.id);
  t.conversation_id = id;
  return id;
}

async function systemLine(conversationId: string, actorId: string, body: string) {
  await db.from('messages').insert({ conversation_id: conversationId, sender_id: actorId, body, system: true });
}

/** An admin answers in the thread: the user gets it in Messages, as a push, and by email. */
export async function postStaffReply(t: Ticket, adminId: string, body: string, attachment?: { path: string; name: string; type: string; size: number }) {
  const conversationId = await ensureTicketConversation(t);
  const { data: conv } = await db.from('conversations').select('closed_at').eq('id', conversationId).single();
  if (conv?.closed_at) throw conflict('This ticket is closed. Reopen it to reply.', 'TICKET_CLOSED');
  const row: Record<string, unknown> = { conversation_id: conversationId, sender_id: adminId, body: body.trim() || null };
  if (attachment) Object.assign(row, { attachment_path: attachment.path, attachment_name: attachment.name, attachment_type: attachment.type, attachment_size: attachment.size });
  const message = unwrap(await db.from('messages').insert(row).select().single());
  const now = new Date().toISOString();
  await db.from('support_tickets').update({
    awaiting: 'user', last_message_at: now, admin_note: (body || (attachment ? `[${attachment.name}]` : '')).slice(0, 2000), updated_at: now,
    ...(t.status === 'open' ? { status: 'in_progress' } : {}),
  }).eq('id', t.id);
  const fileLabel = attachment ? (attachment.type.startsWith('image/') ? '📷 Photo' : `📎 ${attachment.name}`) : '📎 Attachment';
  await notify(t.user_id, 'support_update', 'RentCreeb Support replied', body.trim().slice(0, 140) || fileLabel, { conversationId, ticketId: t.id });
  void emailUser(t, 'RentCreeb Support replied', (body.trim() ? `<p>${esc(body).replace(/\n/g, '<br/>')}</p>` : '') + (attachment ? `<p>${esc(fileLabel)} (open the app to view it)</p>` : ''));
  return message;
}

/**
 * Status change from the dashboard. Closing locks the thread at once (the open chat in the app sees the closing line
 * arrive over Realtime and swaps the composer for a "closed" notice). Reopening unlocks it.
 */
export async function setTicketStatus(t: Ticket, adminId: string, status: 'open' | 'in_progress' | 'resolved' | 'closed') {
  const conversationId = await ensureTicketConversation(t);
  const now = new Date().toISOString();
  const wasClosed = t.status === 'closed';
  if (status === t.status) return;
  const patch: Record<string, unknown> = { status, updated_at: now };
  if (status === 'closed') {
    Object.assign(patch, { closed_at: now, awaiting: null });
    await db.from('conversations').update({ closed_at: now }).eq('id', conversationId);
    await systemLine(conversationId, adminId, 'RentCreeb Support closed this conversation. If you still need help, start a new request from Settings → Contact Support.');
    await notify(t.user_id, 'support_update', 'Your support request was closed', t.subject, { conversationId, ticketId: t.id });
  } else if (wasClosed) {
    Object.assign(patch, { closed_at: null });
    await db.from('conversations').update({ closed_at: null }).eq('id', conversationId);
    await systemLine(conversationId, adminId, 'RentCreeb Support reopened this conversation. You can reply here again.');
    await notify(t.user_id, 'support_update', 'Your support request was reopened', t.subject, { conversationId, ticketId: t.id });
  } else if (status === 'resolved') {
    Object.assign(patch, { awaiting: null });
    await systemLine(conversationId, adminId, 'Marked as resolved. Reply here if you still need help; the conversation stays open until support closes it.');
    await notify(t.user_id, 'support_update', 'Your support request was resolved', t.subject, { conversationId, ticketId: t.id });
  }
  await db.from('support_tickets').update(patch).eq('id', t.id);
  if (status === 'closed') void emailUser(t, 'Your support request was closed', '<p>Our team has closed this request. If you still need help, start a new request from Settings → Contact Support in the app.</p>');
}

/** The user wrote in their support thread: re-open a resolved ticket and put it back in the staff queue. */
export async function onUserSupportMessage(ticketId: string, preview: string, from: { first_name?: string | null; last_name?: string | null; email?: string | null }) {
  const { data: t } = await db.from('support_tickets').select('id, status, subject, kind').eq('id', ticketId).maybeSingle();
  if (!t) return;
  const now = new Date().toISOString();
  await db.from('support_tickets').update({ awaiting: 'staff', last_message_at: now, updated_at: now, ...(t.status === 'resolved' ? { status: 'open' } : {}) }).eq('id', ticketId);
  if (env.SUPPORT_EMAIL) {
    const who = `${from.first_name ?? ''} ${from.last_name ?? ''}`.trim() || from.email || 'A user';
    void sendEmail(env.SUPPORT_EMAIL, `Re: [${t.kind}] ${t.subject}`, `<p><b>${esc(who)}</b> replied on ticket ${t.id}:</p><p>${esc(preview).replace(/\n/g, '<br/>')}</p><p>Answer in the admin dashboard → Support.</p>`);
  }
}

async function emailUser(t: Ticket, subject: string, inner: string) {
  try {
    const { data: p } = await db.from('profiles').select('email, first_name').eq('id', t.user_id).maybeSingle();
    if (!p?.email) return;
    await sendEmail(p.email, `${subject}: ${t.subject}`,
      `<p>Hi ${esc(p.first_name || 'there')},</p>${inner}<p style="color:#5b6680">Reply in the RentCreeb app (Messages → RentCreeb Support) to continue the conversation. Replies to this email are not monitored.</p>`);
  } catch (err) { logger.warn({ err }, 'support email to user failed'); }
}
