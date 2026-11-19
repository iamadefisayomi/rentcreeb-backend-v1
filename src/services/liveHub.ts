import type { RealtimeChannel } from '@supabase/supabase-js';
import { db } from '../lib/supabase';
import { logger } from '../lib/logger';
import { isTyping } from './presence';

/**
 * Live updates for the admin dashboard. The dashboard can only talk to this API (its security policy blocks other
 * hosts), so the API subscribes to Supabase Realtime once per conversation and fans events out to every admin
 * watching it over a server-sent-events stream (routes/admin/content.ts → GET /admin/live).
 *
 *   conversation   new messages, read receipts, and the app user typing (Realtime broadcast or the HTTP fallback)
 *   tickets        any support ticket created or changed (inbox refresh); needs migration 021
 */
export type LiveEvent =
  | { type: 'message'; op: 'insert' | 'update'; id: string }
  | { type: 'typing'; userId: string; on: boolean }
  | { type: 'ticket'; id: string; op: string };
type Listener = (e: LiveEvent) => void;

type Room = { channel: RealtimeChannel; listeners: Set<Listener>; typingChannel: RealtimeChannel | null; poll: NodeJS.Timeout | null; lastTyping: boolean };
const rooms = new Map<string, Room>();

/** Watch one chat. `userId` is the app user, whose typing we report. Returns an unsubscribe function. */
export function watchConversation(conversationId: string, userId: string, listener: Listener): () => void {
  let room = rooms.get(conversationId);
  if (!room) {
    const listeners = new Set<Listener>();
    const emit = (e: LiveEvent) => { for (const l of listeners) { try { l(e); } catch { /* one bad stream must not stop the rest */ } } };
    const channel = db.channel(`admin-live:${conversationId}`)
      .on('postgres_changes' as any, { event: '*', schema: 'public', table: 'messages', filter: `conversation_id=eq.${conversationId}` },
        (p: any) => { const row = p.new ?? p.old; if (row?.id && (p.eventType === 'INSERT' || p.eventType === 'UPDATE')) emit({ type: 'message', op: p.eventType === 'INSERT' ? 'insert' : 'update', id: row.id }); })
      .subscribe((status: string) => { if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') logger.warn({ conversationId, status }, 'live hub: message channel problem'); });
    // The app announces typing on a private broadcast channel "chat:<id>" (Realtime Authorization, migration 012).
    // The service role may join it; if that ever fails, the HTTP typing fallback below still works.
    let typingChannel: RealtimeChannel | null = null;
    try {
      typingChannel = db.channel(`chat:${conversationId}`, { config: { private: true, broadcast: { self: false } } })
        .on('broadcast', { event: 'typing' }, (p: any) => { if (p?.payload?.userId) emit({ type: 'typing', userId: String(p.payload.userId), on: !!p.payload.typing }); })
        .subscribe();
    } catch (err) { logger.debug({ err }, 'live hub: typing channel unavailable'); }
    room = { channel, listeners, typingChannel, poll: null, lastTyping: false };
    const r = room;
    // Fallback for apps without Realtime: they ping POST /conversations/:id/typing, which lands in presence.
    r.poll = setInterval(() => {
      const now = isTyping(conversationId, userId);
      if (now !== r.lastTyping) { r.lastTyping = now; emit({ type: 'typing', userId, on: now }); }
    }, 1500);
    rooms.set(conversationId, room);
  }
  room.listeners.add(listener);
  return () => {
    const r = rooms.get(conversationId); if (!r) return;
    r.listeners.delete(listener);
    if (!r.listeners.size) {
      if (r.poll) clearInterval(r.poll);
      void db.removeChannel(r.channel).catch(() => {});
      if (r.typingChannel) void db.removeChannel(r.typingChannel).catch(() => {});
      rooms.delete(conversationId);
    }
  };
}

/** Admin typing, shown in the app's chat header. Uses the same broadcast channel the app listens on. */
export async function broadcastTyping(conversationId: string, adminId: string, on: boolean) {
  const room = rooms.get(conversationId);
  const ch = room?.typingChannel;
  if (!ch) return;
  try { await ch.send({ type: 'broadcast', event: 'typing', payload: { userId: adminId, typing: on } }); } catch { /* best effort */ }
}

// ── tickets feed (one shared subscription for every open inbox) ──
const ticketListeners = new Set<Listener>();
let ticketChannel: RealtimeChannel | null = null;
export function watchTickets(listener: Listener): () => void {
  if (!ticketChannel) {
    ticketChannel = db.channel('admin-live:tickets')
      .on('postgres_changes' as any, { event: '*', schema: 'public', table: 'support_tickets' }, (p: any) => {
        const row = p.new ?? p.old; if (!row?.id) return;
        for (const l of ticketListeners) { try { l({ type: 'ticket', id: row.id, op: String(p.eventType).toLowerCase() }); } catch { /* ignore */ } }
      })
      .subscribe();
  }
  ticketListeners.add(listener);
  return () => {
    ticketListeners.delete(listener);
    if (!ticketListeners.size && ticketChannel) { void db.removeChannel(ticketChannel).catch(() => {}); ticketChannel = null; }
  };
}
