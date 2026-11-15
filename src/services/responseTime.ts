import { db } from '../lib/supabase';

/**
 * How fast someone usually replies in chat, from the last 90 days of conversations.
 *
 * For every message someone sends them, the clock starts; their next message in that chat stops it.
 * We report the median (a typical reply, not skewed by one reply after a long weekend), and only once
 * there are enough replies to be meaningful. Cached per user for 30 minutes.
 */
const WINDOW_DAYS = 90;
const MIN_SAMPLES = 3;
const MAX_GAP_MS = 7 * 24 * 60 * 60 * 1000; // ignore conversations that were simply abandoned
const CACHE_MS = 30 * 60 * 1000;

export type ResponseTime = { medianMinutes: number; samples: number; label: string } | null;
const cache = new Map<string, { at: number; value: ResponseTime }>();

export function responseLabel(min: number) {
  if (min <= 15) return 'Usually responds within 15 minutes';
  if (min <= 60) return 'Usually responds within an hour';
  if (min <= 3 * 60) return 'Usually responds within a few hours';
  if (min <= 24 * 60) return 'Usually responds within a day';
  return 'Usually responds within a few days';
}

export async function responseTime(userId: string): Promise<ResponseTime> {
  const hit = cache.get(userId);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;

  const since = new Date(Date.now() - WINDOW_DAYS * 864e5).toISOString();
  const { data: convs } = await db.from('conversations').select('id').or(`participant_a.eq.${userId},participant_b.eq.${userId}`).limit(500);
  const ids = (convs ?? []).map((c: { id: string }) => c.id);
  let value: ResponseTime = null;
  if (ids.length) {
    const { data: msgs } = await db.from('messages').select('conversation_id, sender_id, created_at, body')
      .in('conversation_id', ids).gte('created_at', since).order('created_at', { ascending: true }).limit(5000);
    const waiting = new Map<string, number>(); // conversation → when the other person started waiting
    const gaps: number[] = [];
    for (const m of (msgs ?? []) as { conversation_id: string; sender_id: string; created_at: string; body: string | null }[]) {
      if (m.body?.startsWith('📞 ')) continue; // call-log lines are not replies
      const t = Date.parse(m.created_at);
      if (m.sender_id !== userId) { if (!waiting.has(m.conversation_id)) waiting.set(m.conversation_id, t); continue; }
      const start = waiting.get(m.conversation_id);
      if (start !== undefined) { const gap = t - start; if (gap >= 0 && gap <= MAX_GAP_MS) gaps.push(gap); waiting.delete(m.conversation_id); }
    }
    if (gaps.length >= MIN_SAMPLES) {
      gaps.sort((a, b) => a - b);
      const mid = Math.floor(gaps.length / 2);
      const median = gaps.length % 2 ? gaps[mid] : (gaps[mid - 1] + gaps[mid]) / 2;
      const minutes = Math.max(1, Math.round(median / 60000));
      value = { medianMinutes: minutes, samples: gaps.length, label: responseLabel(minutes) };
    }
  }
  cache.set(userId, { at: Date.now(), value });
  return value;
}
