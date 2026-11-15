/**
 * Ephemeral presence: who is online (made an API request recently) and who is typing in which chat.
 *
 * Kept in memory on purpose — it changes every few seconds and is worthless after a restart, so it
 * never touches the database. This assumes a single API instance (the Render web service); if the API
 * is ever scaled out, move these maps to Redis or Supabase Realtime presence.
 */
const ONLINE_MS = 25_000; // the app pings at least every few seconds while open (call watcher, chat polls)
const TYPING_MS = 6_000; // a typing ping lasts this long unless refreshed or cleared

const lastSeen = new Map<string, number>();
const typingUntil = new Map<string, number>();

export function markSeen(userId: string) {
  lastSeen.set(userId, Date.now());
}

export function presenceOf(userId: string) {
  const at = lastSeen.get(userId) ?? null;
  return { online: at !== null && Date.now() - at < ONLINE_MS, lastSeenAt: at ? new Date(at).toISOString() : null };
}

export function setTyping(conversationId: string, userId: string, on: boolean) {
  const key = `${conversationId}:${userId}`;
  if (on) typingUntil.set(key, Date.now() + TYPING_MS);
  else typingUntil.delete(key);
}

export function isTyping(conversationId: string, userId: string) {
  const until = typingUntil.get(`${conversationId}:${userId}`);
  return !!until && until > Date.now();
}

// Housekeeping so the maps don't grow forever.
setInterval(() => {
  const now = Date.now();
  for (const [k, until] of typingUntil) if (until < now) typingUntil.delete(k);
  for (const [k, at] of lastSeen) if (now - at > 24 * 60 * 60 * 1000) lastSeen.delete(k);
}, 60_000).unref();
