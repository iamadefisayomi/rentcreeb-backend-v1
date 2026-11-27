import { createHmac, timingSafeEqual } from 'crypto';
import { env } from '../config/env';
import { db } from '../lib/supabase';
import { logger } from '../lib/logger';
import { emailEnabled, sendEmail, sendEmailBatch, type EmailMessage } from '../lib/email';

/**
 * Mailing list service (migration 018).
 *
 *   contacts   everyone we can email: app users (synced from profiles) + outside contacts (imports, sign-up form)
 *   lists      named groups; public lists appear on the preferences page and the sign-up form
 *   campaigns  one-off emails to an audience, sent now or scheduled, through a rate-limited queue (mailing_sends)
 *   automations  an email sent N hours after someone signs up / is added / joins a list (chain them for a drip series)
 *
 * Consent rules, checked when an email is queued AND again when it is sent:
 *   marketing  contact is "subscribed"; app users must also have Privacy → Marketing turned on
 *   service    app users with an account (account news), or subscribed outside contacts
 *   never      bounced, complained, pending (unconfirmed) contacts; deleted accounts
 */

export type Kind = 'marketing' | 'service';
export type Audience = {
  listIds?: string[]; tags?: string[]; excludeTags?: string[];
  source?: 'all' | 'app_users' | 'contacts';
  roles?: string[]; verification?: 'any' | 'verified' | 'unverified';
  /** Only people on the website waitlist (contacts tagged "waitlist"); `waitlistStatuses` narrows it (empty = all). */
  waitlist?: boolean; waitlistStatuses?: string[];
};
export type Contact = {
  id: string; email: string; first_name: string | null; last_name: string | null; user_id: string | null; source: string; status: string;
  tags: string[]; attributes: Record<string, unknown>; token: string; created_at: string;
};
type Profile = { id: string; role: string; nin_verified: boolean; is_suspended: boolean; deleted_at: string | null; privacy_prefs: any; first_name?: string | null; last_name?: string | null };
export type Content = { subject: string; preheader?: string | null; html: string; from_name?: string | null; reply_to?: string | null; kind: Kind; track?: boolean };

const CONTACT_COLS = 'id, email, first_name, last_name, user_id, source, status, tags, attributes, token, created_at';
export const normalizeEmail = (e: string) => e.trim().toLowerCase();
export const isEmail = (e: string) => /^[^\s@<>()",;]+@[^\s@<>()",;]+\.[a-z]{2,}$/i.test(e);
const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const chunk = <T>(a: T[], n: number) => Array.from({ length: Math.ceil(a.length / n) }, (_, i) => a.slice(i * n, i * n + n));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ───────── readiness, links, signatures ─────────
export function mailStatus() {
  return {
    provider: emailEnabled(), publicUrl: env.API_PUBLIC_URL ?? null, webhook: !!env.RESEND_WEBHOOK_SECRET, from: env.EMAIL_FROM,
    address: env.MAIL_COMPANY_ADDRESS, ratePerMinute: env.MAIL_SENDS_PER_MINUTE,
  };
}
/** Throws a readable error when campaigns can't go out yet. */
export function assertReady() {
  if (!emailEnabled()) throw new Error('Email sending is not set up: add RESEND_API_KEY to the server settings.');
  if (!env.API_PUBLIC_URL) throw new Error('Set API_PUBLIC_URL (the public address of this API) so emails can carry unsubscribe links.');
}
const SECRET = () => createHmac('sha256', env.OTP_PEPPER).update('mailing-links').digest();
export const sign = (v: string) => createHmac('sha256', SECRET()).update(v).digest('base64url').slice(0, 22);
export function verifySig(v: string, sig: string) {
  const a = Buffer.from(sign(v)); const b = Buffer.from(String(sig));
  return a.length === b.length && timingSafeEqual(a, b);
}
const base = () => `${env.API_PUBLIC_URL ?? ''}/mail`;
export const links = {
  prefs: (token: string) => `${base()}/u/${token}`,
  unsubscribe: (token: string, sendId?: string) => `${base()}/u/${token}${sendId ? `?s=${sendId}` : ''}`,
  oneClick: (token: string, sendId?: string) => `${base()}/u/${token}/one-click${sendId ? `?s=${sendId}` : ''}`,
  confirm: (token: string) => `${base()}/confirm/${token}`,
  open: (sendId: string) => `${base()}/o/${sendId}.gif`,
  click: (sendId: string, url: string) => `${base()}/c/${sendId}?u=${encodeURIComponent(url)}&s=${sign(sendId + '|' + url)}`,
  view: (sendId: string) => `${base()}/v/${sendId}?s=${sign('view|' + sendId)}`,
};

// ───────── rendering ─────────
/** {{first_name}}, {{first_name|there}}, {{email}}, {{attributes.city}}, {{unsubscribe_url}}, {{preferences_url}}, {{view_url}}, {{app_url}}. */
export function merge(html: string, vars: Record<string, unknown>) {
  return html.replace(/\{\{\s*([a-z0-9_.]+)\s*(?:\|([^}]*))?\}\}/gi, (_m, key: string, fallback?: string) => {
    const v = key.split('.').reduce<any>((o, k) => (o == null ? undefined : o[k]), vars);
    const s = v == null || v === '' ? fallback ?? '' : String(v);
    return /_url$/.test(key) ? s : esc(s);
  });
}

/** Plain text (no "<") becomes simple HTML: paragraphs, line breaks, **bold**, [link](https://…), bare links. */
export function textToHtml(src: string) {
  if (/<[a-z!/][\s\S]*>/i.test(src)) return src;
  return src.trim().split(/\n{2,}/).map((p) => {
    let h = esc(p).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2">$1</a>')
      .replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, '$1<a href="$2">$2</a>').replace(/\n/g, '<br>');
    if (/^#\s/.test(p)) h = `<h1>${h.replace(/^#\s/, '')}</h1>`;
    else if (/^##\s/.test(p)) h = `<h2>${h.replace(/^##\s/, '')}</h2>`;
    else h = `<p>${h}</p>`;
    return h;
  }).join('\n');
}

export function htmlToText(html: string) {
  return html.replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<a [^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, '$2 ($1)')
    .replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|h[1-6]|div|tr|li)>/gi, '\n\n').replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * The RentCreeb logo for the email header: a PNG (email apps don't show SVG) served with the admin files,
 * backend/admin/logo-email.png, made from assets/brand/rentcreeb-logo.svg at 3x. Falls back to a text wordmark
 * when the server's public URL isn't known (local runs without API_PUBLIC_URL).
 */
const logo = () => env.API_PUBLIC_URL
  ? `<img src="${env.API_PUBLIC_URL}/admin/logo-email.png" width="152" height="23" alt="RentCreeb" style="display:inline-block;border:0;outline:none;text-decoration:none;width:152px;height:23px;vertical-align:middle">`
  : 'Rent<span style="color:#2563eb">Creeb</span>';

/** Branded, email-client-safe wrapper with preheader and footer. */
export function layout(inner: string, o: { preheader?: string | null; kind: Kind; prefsUrl?: string; unsubUrl?: string; viewUrl?: string }) {
  const foot = o.kind === 'marketing'
    ? `You are receiving this because you subscribed to RentCreeb emails.<br><a href="${o.unsubUrl ?? '#'}" style="color:#5b6680">Unsubscribe</a> · <a href="${o.prefsUrl ?? '#'}" style="color:#5b6680">Email preferences</a>`
    : 'This is a service message about your RentCreeb account.';
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light">
<style>body{margin:0;background:#f4f6fb}a{color:#2563eb}h1{font-size:24px;line-height:1.25;margin:0 0 14px}h2{font-size:18px;margin:22px 0 10px}p{margin:0 0 14px}img{max-width:100%;height:auto}
.btn{display:inline-block;background:#2563eb;color:#fff !important;text-decoration:none;padding:12px 22px;border-radius:9px;font-weight:600}</style></head>
<body><span style="display:none!important;visibility:hidden;opacity:0;height:0;width:0;overflow:hidden;mso-hide:all">${esc(o.preheader ?? '')}&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;</span>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f6fb"><tr><td align="center" style="padding:28px 12px">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%">
<tr><td style="padding:0 6px 16px;font:700 20px Arial,sans-serif;color:#0b1533">${logo()}${o.viewUrl ? `<span style="float:right;font:400 12px Arial,sans-serif"><a href="${o.viewUrl}" style="color:#98a1b8">View in browser</a></span>` : ''}</td></tr>
<tr><td style="background:#fff;border-radius:14px;padding:30px 28px;font:15px/1.6 Arial,sans-serif;color:#111a33">${inner}</td></tr>
<tr><td style="padding:18px 10px;font:12px/1.6 Arial,sans-serif;color:#98a1b8;text-align:center">${foot}<br>${esc(env.MAIL_COMPANY_ADDRESS)}</td></tr>
</table></td></tr></table></body></html>`;
}

/** Click tracking: route http(s) links through /mail/c (signed, so it can't be used as an open redirect). Our own /mail links are left alone. */
function trackLinks(html: string, sendId: string) {
  return html.replace(/href="(https?:\/\/[^"]+)"/gi, (m, url: string) => {
    const decoded = url.replace(/&amp;/g, '&');
    return decoded.startsWith(base()) ? m : `href="${links.click(sendId, decoded).replace(/&/g, '&amp;')}"`;
  });
}

function varsFor(c: Pick<Contact, 'email' | 'first_name' | 'last_name' | 'attributes' | 'token'>, sendId?: string) {
  return {
    first_name: c.first_name, last_name: c.last_name, full_name: [c.first_name, c.last_name].filter(Boolean).join(' '), email: c.email,
    attributes: c.attributes ?? {}, app_url: env.APP_BASE_URL,
    unsubscribe_url: links.unsubscribe(c.token, sendId), preferences_url: links.prefs(c.token), view_url: sendId ? links.view(sendId) : env.APP_BASE_URL,
  };
}

/** The final email for one person. `sendId` is omitted for previews and tests (no tracking). */
export function render(content: Content, c: Pick<Contact, 'email' | 'first_name' | 'last_name' | 'attributes' | 'token'>, sendId?: string) {
  const vars = varsFor(c, sendId);
  const body = merge(textToHtml(content.html || ''), vars);
  let html = layout(body, { preheader: merge(content.preheader ?? '', vars), kind: content.kind, prefsUrl: vars.preferences_url, unsubUrl: vars.unsubscribe_url, viewUrl: sendId ? vars.view_url : undefined });
  if (sendId && content.track !== false) html = trackLinks(html, sendId).replace('</body>', `<img src="${links.open(sendId)}" width="1" height="1" alt="" style="display:block;border:0;width:1px;height:1px"></body>`);
  const subject = merge(content.subject || '(no subject)', vars).replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"');
  return { subject, html, text: htmlToText(body) + (content.kind === 'marketing' ? `\n\nUnsubscribe: ${vars.unsubscribe_url}` : '') };
}

function message(content: Content, c: Contact, sendId: string): EmailMessage {
  const r = render(content, c, sendId);
  const headers: Record<string, string> = { 'X-Entity-Ref-ID': sendId };
  if (content.kind === 'marketing') {
    // RFC 8058 one-click unsubscribe: Gmail / Yahoo show their own "Unsubscribe" button and require this for bulk senders.
    headers['List-Unsubscribe'] = `<${links.oneClick(c.token, sendId)}>`;
    headers['List-Unsubscribe-Post'] = 'List-Unsubscribe=One-Click';
  }
  return { to: c.email, subject: r.subject, html: r.html, text: r.text, fromName: content.from_name ?? undefined, replyTo: content.reply_to ?? undefined, headers };
}

// ───────── contacts ─────────
async function allRows<T>(build: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: any }>, page = 1000): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += page) {
    const { data, error } = await build(from, from + page - 1);
    if (error) throw new Error(error.message);
    out.push(...(data ?? []));
    if (!data || data.length < page) return out;
  }
}

async function profilesById(ids: string[]) {
  const map = new Map<string, Profile>();
  for (const part of chunk([...new Set(ids)], 300)) {
    const { data } = await db.from('profiles').select('id, role, nin_verified, is_suspended, deleted_at, privacy_prefs, first_name, last_name').in('id', part);
    for (const p of (data ?? []) as Profile[]) map.set(p.id, p);
  }
  return map;
}

/** Every app user with an email becomes (or stays linked to) a contact. Never changes a contact's subscription status. */
export async function syncAppUsers() {
  const users = await allRows<{ id: string; email: string | null; first_name: string | null; last_name: string | null; created_at: string }>((f, t) =>
    db.from('profiles').select('id, email, first_name, last_name, created_at').not('email', 'is', null).is('deleted_at', null).order('created_at').range(f, t));
  const valid = users.map((u) => ({ ...u, email: normalizeEmail(u.email!) })).filter((u) => isEmail(u.email));
  let added = 0, linked = 0;
  for (const part of chunk(valid, 300)) {
    const { data: existing } = await db.from('mailing_contacts').select('id, email, user_id, first_name, last_name').in('email', part.map((u) => u.email));
    const byEmail = new Map((existing ?? []).map((c: any) => [c.email, c]));
    const fresh = part.filter((u) => !byEmail.has(u.email));
    if (fresh.length) {
      const { data, error } = await db.from('mailing_contacts').upsert(fresh.map((u) => ({
        email: u.email, first_name: u.first_name, last_name: u.last_name, user_id: u.id, source: 'app_user', status: 'subscribed', consent_at: u.created_at, created_at: u.created_at,
      })), { onConflict: 'email', ignoreDuplicates: true }).select('id');
      if (error) logger.warn({ err: error.message }, 'mailing sync insert');
      added += data?.length ?? 0;
    }
    for (const u of part) {
      const c: any = byEmail.get(u.email);
      if (c && (c.user_id !== u.id || (!c.first_name && u.first_name))) {
        await db.from('mailing_contacts').update({ user_id: u.id, first_name: c.first_name || u.first_name, last_name: c.last_name || u.last_name, updated_at: new Date().toISOString() }).eq('id', c.id);
        linked++;
      }
    }
  }
  return { users: valid.length, added, linked };
}

/** Why someone can't get this kind of email right now (null = they can). */
export function blockedReason(kind: Kind, c: Pick<Contact, 'status' | 'user_id'>, p?: Profile | null): string | null {
  if (c.status === 'bounced') return 'bounced';
  if (c.status === 'complained') return 'marked as spam';
  if (c.status === 'pending') return 'not confirmed';
  if (c.user_id && (!p || p.deleted_at)) return 'account deleted';
  if (kind === 'service') return c.user_id || c.status === 'subscribed' ? null : 'unsubscribed';
  if (c.status !== 'subscribed') return 'unsubscribed';
  if (p?.is_suspended) return 'account suspended';
  if (p && p.privacy_prefs?.marketing !== true) return 'no marketing consent (app setting)';
  return null;
}

/** Everyone a campaign would reach, plus how many were left out and why. */
export async function resolveAudience(a: Audience, kind: Kind, opts: { sync?: boolean } = {}) {
  if (opts.sync !== false) await syncAppUsers().catch((err) => logger.warn({ err }, 'mailing sync failed'));
  let contacts = await allRows<Contact>((f, t) => db.from('mailing_contacts').select(CONTACT_COLS).order('created_at').range(f, t));
  if (a.listIds?.length) {
    const members = await allRows<{ contact_id: string }>((f, t) => db.from('mailing_list_members').select('contact_id').in('list_id', a.listIds!).eq('status', 'subscribed').range(f, t));
    const set = new Set(members.map((m) => m.contact_id));
    contacts = contacts.filter((c) => set.has(c.id));
  }
  if (a.tags?.length) contacts = contacts.filter((c) => c.tags?.some((t) => a.tags!.includes(t)));
  if (a.waitlist) {
    contacts = contacts.filter((c) => c.tags?.includes('waitlist'));
    if (a.waitlistStatuses?.length) contacts = contacts.filter((c) => a.waitlistStatuses!.includes(String((c.attributes as any)?.waitlistStatus || 'pending')));
  }
  if (a.excludeTags?.length) contacts = contacts.filter((c) => !c.tags?.some((t) => a.excludeTags!.includes(t)));
  const appOnly = a.source === 'app_users' || !!a.roles?.length || (a.verification && a.verification !== 'any');
  if (appOnly) contacts = contacts.filter((c) => c.user_id);
  if (a.source === 'contacts') contacts = contacts.filter((c) => !c.user_id);
  const profiles = await profilesById(contacts.filter((c) => c.user_id).map((c) => c.user_id!));
  if (a.roles?.length) contacts = contacts.filter((c) => a.roles!.includes(profiles.get(c.user_id!)?.role ?? ''));
  if (a.verification === 'verified') contacts = contacts.filter((c) => profiles.get(c.user_id!)?.nin_verified);
  if (a.verification === 'unverified') contacts = contacts.filter((c) => !profiles.get(c.user_id!)?.nin_verified);
  const excluded: Record<string, number> = {};
  const eligible = contacts.filter((c) => {
    const why = blockedReason(kind, c, c.user_id ? profiles.get(c.user_id) : null);
    if (why) excluded[why] = (excluded[why] ?? 0) + 1;
    return !why;
  });
  return { eligible, matched: contacts.length, excluded };
}

// ───────── queue ─────────
/** Turn a campaign into queued sends. */
export async function queueCampaign(campaignId: string) {
  const { data: c } = await db.from('mailing_campaigns').select('*').eq('id', campaignId).single();
  if (!c) throw new Error('Campaign not found');
  const { eligible } = await resolveAudience(c.audience ?? {}, c.kind);
  const now = new Date().toISOString();
  for (const part of chunk(eligible, 500)) {
    const { error } = await db.from('mailing_sends').upsert(part.map((x) => ({ campaign_id: c.id, contact_id: x.id, email: x.email, send_after: now })), { onConflict: 'campaign_id,contact_id', ignoreDuplicates: true });
    if (error) throw new Error(error.message);
  }
  const { count } = await db.from('mailing_sends').select('id', { count: 'exact', head: true }).eq('campaign_id', c.id);
  await db.from('mailing_campaigns').update({ status: 'sending', started_at: c.started_at ?? now, recipients: count ?? eligible.length, updated_at: now }).eq('id', c.id);
  return count ?? eligible.length;
}

/** New people for each live automation get a queued send, timed by its delay. */
export async function enqueueAutomations() {
  const { data: autos } = await db.from('mailing_automations').select('*').eq('active', true);
  for (const a of autos ?? []) {
    try {
      const since = a.activated_at ?? a.created_at;
      let hits: { contact_id: string; email: string; at: string }[] = [];
      if (a.trigger === 'user_signup') {
        let q = db.from('profiles').select('id, email, created_at, role').gte('created_at', since).not('email', 'is', null).is('deleted_at', null).limit(2000);
        if (a.roles?.length) q = q.in('role', a.roles);
        const { data: users } = await q;
        if (users?.length) {
          await syncAppUsers();
          const { data: cs } = await db.from('mailing_contacts').select('id, email, user_id').in('user_id', users.map((u: any) => u.id));
          const at = new Map(users.map((u: any) => [u.id, u.created_at]));
          hits = (cs ?? []).map((c: any) => ({ contact_id: c.id, email: c.email, at: at.get(c.user_id) }));
        }
      } else if (a.trigger === 'contact_added') {
        const { data } = await db.from('mailing_contacts').select('id, email, created_at').gte('created_at', since).neq('source', 'app_user').limit(2000);
        hits = (data ?? []).map((c: any) => ({ contact_id: c.id, email: c.email, at: c.created_at }));
      } else if (a.trigger === 'waitlist_joined') {
        // Normally already sent by sendWaitlistWelcome() at sign-up; this catches anyone it missed (and imports tagged "waitlist").
        const [joined, added] = await Promise.all([
          db.from('mailing_contacts').select('id, email, attributes').contains('tags', ['waitlist']).gte('attributes->>waitlistJoinedAt', since).limit(2000),
          db.from('mailing_contacts').select('id, email, created_at').contains('tags', ['waitlist']).is('attributes->>waitlistJoinedAt', null).gte('created_at', since).limit(2000),
        ]);
        hits = [...(joined.data ?? []).map((c: any) => ({ contact_id: c.id, email: c.email, at: c.attributes.waitlistJoinedAt })),
          ...(added.data ?? []).map((c: any) => ({ contact_id: c.id, email: c.email, at: c.created_at }))];
      } else if (a.trigger === 'list_joined' && a.list_id) {
        const { data } = await db.from('mailing_list_members').select('added_at, contact:mailing_contacts(id, email)').eq('list_id', a.list_id).eq('status', 'subscribed').gte('added_at', since).limit(2000);
        hits = (data ?? []).filter((m: any) => m.contact).map((m: any) => ({ contact_id: m.contact.id, email: m.contact.email, at: m.added_at }));
      }
      for (const part of chunk(hits, 500)) {
        await db.from('mailing_sends').upsert(part.map((h) => ({ automation_id: a.id, contact_id: h.contact_id, email: h.email,
          send_after: new Date(Date.parse(h.at) + a.delay_hours * 3600_000).toISOString() })), { onConflict: 'automation_id,contact_id', ignoreDuplicates: true });
      }
    } catch (err) { logger.error({ err, automation: a.id }, 'automation enqueue failed'); }
  }
}

/**
 * The waitlist welcome went out: move these people from "pending" to "contacted" in Admin → Waitlist.
 * Anyone an admin already moved further along (invited, joined, not interested) is left as they are.
 */
export async function markWaitlistContacted(contactIds: string[], at = new Date().toISOString()) {
  if (!contactIds.length) return;
  try {
    const { data } = await db.from('mailing_contacts').select('id, attributes').in('id', [...new Set(contactIds)]).contains('tags', ['waitlist']);
    await Promise.all((data ?? []).filter((c: any) => !c.attributes?.waitlistStatus || c.attributes.waitlistStatus === 'pending').map((c: any) =>
      db.from('mailing_contacts').update({ attributes: { ...(c.attributes ?? {}), waitlistStatus: 'contacted', waitlistContactedAt: at }, updated_at: at }).eq('id', c.id)));
  } catch (err: any) { logger.warn({ err: err?.message }, 'could not mark waitlist contacts as contacted'); }
}

/**
 * Send the live "waitlist_joined" automation(s) to someone the moment they join, instead of waiting for the minute job.
 * Returns false when there is no live welcome automation or email isn't set up, so the caller can send a plain fallback.
 * The send is recorded in mailing_sends (one per automation and contact), so the minute job never sends it twice.
 */
export async function sendWaitlistWelcome(contactId: string) {
  if (!emailEnabled() || !env.API_PUBLIC_URL) return false;
  const { data: autos } = await db.from('mailing_automations').select('*').eq('active', true).eq('trigger', 'waitlist_joined').eq('delay_hours', 0);
  if (!autos?.length) return false;
  const { data: c } = await db.from('mailing_contacts').select(CONTACT_COLS).eq('id', contactId).maybeSingle();
  if (!c) return false;
  const profile = c.user_id ? (await profilesById([c.user_id])).get(c.user_id) : null;
  let handled = false;
  for (const a of autos) {
    const why = blockedReason(a.kind, c as Contact, profile);
    const { data: row } = await db.from('mailing_sends').upsert({ automation_id: a.id, contact_id: c.id, email: c.email, send_after: new Date().toISOString(), status: why ? 'skipped' : 'sending', error: why },
      { onConflict: 'automation_id,contact_id', ignoreDuplicates: true }).select('id').maybeSingle();
    if (!row) continue; // already had it
    handled = true; // sent, queued, or deliberately skipped (e.g. bounced address): no fallback email either way
    if (why) continue;
    try {
      const [id] = await sendEmailBatch([message(a, c as Contact, row.id)]);
      const at = new Date().toISOString();
      await db.from('mailing_sends').update({ status: 'sent', provider_id: id ?? null, sent_at: at, attempts: 1 }).eq('id', row.id);
      await db.from('mailing_contacts').update({ last_sent_at: at }).eq('id', c.id);
      await markWaitlistContacted([c.id], at);
    } catch (err: any) {
      // Leave it to the minute job to retry.
      logger.warn({ err: err?.message }, 'waitlist welcome send failed; queued for retry');
      await db.from('mailing_sends').update({ status: 'queued', attempts: 1, send_after: new Date(Date.now() + 60_000).toISOString(), error: String(err?.message ?? err).slice(0, 300) }).eq('id', row.id);
    }
  }
  return handled;
}

let running = false;
/** Runs every minute: start due scheduled campaigns, enqueue automations, then deliver one minute's worth of the queue. */
export async function processMailQueue() {
  if (running) return;
  running = true;
  try {
    const now = new Date().toISOString();
    const { data: due } = await db.from('mailing_campaigns').select('id').eq('status', 'scheduled').lte('scheduled_at', now);
    for (const c of due ?? []) await queueCampaign(c.id).catch((err) => logger.error({ err, campaign: c.id }, 'scheduled campaign failed to start'));
    await enqueueAutomations();
    if (!emailEnabled() || !env.API_PUBLIC_URL) return;

    let budget = env.MAIL_SENDS_PER_MINUTE;
    const started = Date.now();
    while (budget > 0 && Date.now() - started < 50_000) {
      const { data: batch } = await db.from('mailing_sends').select('id, campaign_id, automation_id, contact_id, attempts')
        .eq('status', 'queued').lte('send_after', new Date().toISOString()).order('send_after').limit(Math.min(100, budget) * 2);
      if (!batch?.length) break;
      // Parents: skip sends of paused/cancelled campaigns and switched-off automations.
      const cIds = [...new Set(batch.map((s) => s.campaign_id).filter(Boolean))];
      const aIds = [...new Set(batch.map((s) => s.automation_id).filter(Boolean))];
      const [{ data: camps }, { data: autos }] = await Promise.all([
        cIds.length ? db.from('mailing_campaigns').select('*').in('id', cIds) : Promise.resolve({ data: [] as any[] }),
        aIds.length ? db.from('mailing_automations').select('*').in('id', aIds) : Promise.resolve({ data: [] as any[] }),
      ]);
      const content = new Map<string, Content>();
      for (const c of camps ?? []) if (c.status === 'sending') content.set(c.id, c);
      for (const a of autos ?? []) if (a.active) content.set(a.id, a);
      const ready = batch.filter((s) => content.has(s.campaign_id ?? s.automation_id)).slice(0, Math.min(100, budget));
      if (!ready.length) break;
      const { data: claimed } = await db.from('mailing_sends').update({ status: 'sending' }).in('id', ready.map((s) => s.id)).eq('status', 'queued').select('id, campaign_id, automation_id, contact_id, attempts');
      if (!claimed?.length) break;
      const { data: cs } = await db.from('mailing_contacts').select(CONTACT_COLS).in('id', claimed.map((s) => s.contact_id));
      const contacts = new Map(((cs ?? []) as Contact[]).map((c) => [c.id, c]));
      const profiles = await profilesById(((cs ?? []) as Contact[]).filter((c) => c.user_id).map((c) => c.user_id!));
      const out: { send: typeof claimed[number]; msg: EmailMessage }[] = [];
      for (const s of claimed) {
        const c = contacts.get(s.contact_id); const body = content.get(s.campaign_id ?? s.automation_id)!;
        const why = c ? blockedReason(body.kind, c, c.user_id ? profiles.get(c.user_id) : null) : 'contact deleted';
        if (why) { await db.from('mailing_sends').update({ status: 'skipped', error: why }).eq('id', s.id); continue; }
        out.push({ send: s, msg: message(body, c!, s.id) });
      }
      if (out.length) {
        try {
          const ids = await sendEmailBatch(out.map((o) => o.msg));
          const at = new Date().toISOString();
          await Promise.all(out.map((o, i) => db.from('mailing_sends').update({ status: 'sent', provider_id: ids[i] ?? null, sent_at: at, attempts: o.send.attempts + 1, error: null }).eq('id', o.send.id)));
          await db.from('mailing_contacts').update({ last_sent_at: at }).in('id', out.map((o) => o.send.contact_id));
          // Waitlist welcomes delivered by the queue (retries, imports, delayed welcomes) count as contacting them too.
          await markWaitlistContacted(out.filter((o) => (content.get(o.send.automation_id ?? '') as any)?.trigger === 'waitlist_joined').map((o) => o.send.contact_id), at);
        } catch (err: any) {
          const rateLimited = err?.statusCode === 429 || /rate limit/i.test(err?.message ?? '');
          logger.error({ err: err?.message, rateLimited }, 'mailing batch failed');
          await Promise.all(out.map((o) => {
            const attempts = o.send.attempts + (rateLimited ? 0 : 1);
            return db.from('mailing_sends').update(attempts >= 3
              ? { status: 'failed', attempts, error: String(err?.message ?? err).slice(0, 300) }
              : { status: 'queued', attempts, send_after: new Date(Date.now() + (rateLimited ? 60_000 : 5 * 60_000)).toISOString(), error: String(err?.message ?? err).slice(0, 300) }).eq('id', o.send.id);
          }));
          if (rateLimited) break;
        }
      }
      budget -= claimed.length;
      await sleep(600); // stay under the provider's 2 requests/second
    }
  } catch (err) { logger.error({ err }, 'mail queue failed'); }
  finally {
    // Campaigns with nothing left to send are finished.
    try {
      const { data: live } = await db.from('mailing_campaigns').select('id').eq('status', 'sending');
      for (const c of live ?? []) {
        const { count } = await db.from('mailing_sends').select('id', { count: 'exact', head: true }).eq('campaign_id', c.id).in('status', ['queued', 'sending']);
        if (!count) await db.from('mailing_campaigns').update({ status: 'sent', finished_at: new Date().toISOString() }).eq('id', c.id).eq('status', 'sending');
      }
      // A crash mid-batch leaves rows in "sending": put them back after 10 minutes.
      await db.from('mailing_sends').update({ status: 'queued' }).eq('status', 'sending').is('sent_at', null).lt('send_after', new Date(Date.now() - 10 * 60_000).toISOString());
    } catch { /* next run */ }
    running = false;
  }
}

/** Test email to a few addresses, rendered for the first matching contact (or a sample person). No tracking. */
export async function sendTest(content: Content, to: string[]) {
  assertReady();
  const sample = { email: to[0], first_name: 'Ada', last_name: 'Okafor', attributes: {}, token: 'test-preview' };
  for (const addr of to) {
    const { data: c } = await db.from('mailing_contacts').select(CONTACT_COLS).eq('email', normalizeEmail(addr)).maybeSingle();
    const r = render(content, (c as Contact) ?? { ...sample, email: addr });
    await sendEmail(addr, `[Test] ${r.subject}`, r.html, { text: r.text, fromName: content.from_name ?? undefined, replyTo: content.reply_to ?? undefined });
  }
}

// ───────── engagement & suppression ─────────
export async function recordOpen(sendId: string) {
  const { data: s } = await db.from('mailing_sends').select('id, contact_id, opened_at, open_count').eq('id', sendId).maybeSingle();
  if (!s) return;
  const at = new Date().toISOString();
  await db.from('mailing_sends').update({ opened_at: s.opened_at ?? at, open_count: s.open_count + 1 }).eq('id', s.id);
  if (!s.opened_at) { await db.from('mailing_events').insert({ send_id: s.id, contact_id: s.contact_id, type: 'open' }); await db.from('mailing_contacts').update({ last_opened_at: at }).eq('id', s.contact_id); }
}
export async function recordClick(sendId: string, url: string) {
  const { data: s } = await db.from('mailing_sends').select('id, contact_id, clicked_at, click_count, opened_at, open_count').eq('id', sendId).maybeSingle();
  if (!s) return;
  const at = new Date().toISOString();
  // A click proves the email was opened even when images (the open pixel) were blocked.
  await db.from('mailing_sends').update({ clicked_at: s.clicked_at ?? at, click_count: s.click_count + 1, opened_at: s.opened_at ?? at, open_count: Math.max(s.open_count, 1) }).eq('id', s.id);
  await db.from('mailing_events').insert({ send_id: s.id, contact_id: s.contact_id, type: 'click', url: url.slice(0, 1000) });
  await db.from('mailing_contacts').update({ last_clicked_at: at }).eq('id', s.contact_id);
}

/** Unsubscribe from all marketing. App users also get Privacy → Marketing switched off so both places agree. */
export async function unsubscribeContact(contactId: string, opts: { sendId?: string | null; reason?: string | null } = {}) {
  const { data: c } = await db.from('mailing_contacts').select('id, user_id, status').eq('id', contactId).maybeSingle();
  if (!c) return;
  const at = new Date().toISOString();
  if (c.status === 'subscribed' || c.status === 'pending') await db.from('mailing_contacts').update({ status: 'unsubscribed', unsubscribed_at: at, unsubscribe_reason: opts.reason ?? null, updated_at: at }).eq('id', c.id);
  await db.from('mailing_list_members').update({ status: 'unsubscribed' }).eq('contact_id', c.id);
  if (c.user_id) {
    const { data: p } = await db.from('profiles').select('privacy_prefs').eq('id', c.user_id).maybeSingle();
    await db.from('profiles').update({ privacy_prefs: { ...((p?.privacy_prefs as object) ?? {}), marketing: false } }).eq('id', c.user_id);
  }
  if (opts.sendId) await db.from('mailing_sends').update({ unsubscribed_at: at }).eq('id', opts.sendId).eq('contact_id', c.id);
  await db.from('mailing_events').insert({ send_id: opts.sendId ?? null, contact_id: c.id, type: 'unsubscribe' });
}

export async function resubscribeContact(contactId: string) {
  const { data: c } = await db.from('mailing_contacts').select('id, user_id').eq('id', contactId).maybeSingle();
  if (!c) return;
  await db.from('mailing_contacts').update({ status: 'subscribed', unsubscribed_at: null, unsubscribe_reason: null, consent_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq('id', c.id);
  if (c.user_id) {
    const { data: p } = await db.from('profiles').select('privacy_prefs').eq('id', c.user_id).maybeSingle();
    await db.from('profiles').update({ privacy_prefs: { ...((p?.privacy_prefs as object) ?? {}), marketing: true } }).eq('id', c.user_id);
  }
  await db.from('mailing_events').insert({ contact_id: c.id, type: 'subscribe' });
}

/** Resend webhook events (delivery, bounces, spam complaints). Opens/clicks come from our own tracking. */
export async function handleProviderEvent(evt: { type: string; data?: { email_id?: string; bounce?: { type?: string; message?: string } } }) {
  const id = evt.data?.email_id;
  if (!id) return;
  const { data: s } = await db.from('mailing_sends').select('id, contact_id, delivered_at').eq('provider_id', id).maybeSingle();
  if (!s) return;
  const at = new Date().toISOString();
  if (evt.type === 'email.delivered') {
    await db.from('mailing_sends').update({ status: 'delivered', delivered_at: s.delivered_at ?? at }).eq('id', s.id).in('status', ['sent']);
  } else if (evt.type === 'email.bounced') {
    // Permanent bounces stop all future email; temporary ones are just recorded.
    const permanent = !/transient|temporary|soft/i.test(evt.data?.bounce?.type ?? '');
    await db.from('mailing_sends').update({ status: 'bounced', error: evt.data?.bounce?.message?.slice(0, 300) ?? 'bounced' }).eq('id', s.id);
    if (permanent) await db.from('mailing_contacts').update({ status: 'bounced', updated_at: at }).eq('id', s.contact_id);
    await db.from('mailing_events').insert({ send_id: s.id, contact_id: s.contact_id, type: 'bounce' });
  } else if (evt.type === 'email.complained') {
    await db.from('mailing_sends').update({ status: 'complained' }).eq('id', s.id);
    await unsubscribeContact(s.contact_id, { sendId: s.id, reason: 'Marked as spam' });
    await db.from('mailing_contacts').update({ status: 'complained', updated_at: at }).eq('id', s.contact_id);
    await db.from('mailing_events').insert({ send_id: s.id, contact_id: s.contact_id, type: 'complaint' });
  }
}

/** Svix-style signature check used by Resend webhooks. */
export function verifyProviderSignature(raw: Buffer | undefined, headers: Record<string, string | string[] | undefined>) {
  const secret = env.RESEND_WEBHOOK_SECRET;
  if (!secret || !raw) return false;
  const id = String(headers['svix-id'] ?? ''); const ts = String(headers['svix-timestamp'] ?? ''); const sigs = String(headers['svix-signature'] ?? '');
  if (!id || !ts || !sigs || Math.abs(Date.now() / 1000 - Number(ts)) > 300) return false;
  const key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
  const expected = createHmac('sha256', key).update(`${id}.${ts}.${raw.toString('utf8')}`).digest('base64');
  return sigs.split(' ').some((p) => {
    const v = p.split(',')[1] ?? '';
    return v.length === expected.length && timingSafeEqual(Buffer.from(v), Buffer.from(expected));
  });
}

// ───────── reports ─────────
export async function sendStats(filter: { campaign_id?: string; automation_id?: string }) {
  const key = filter.campaign_id ? 'campaign_id' : 'automation_id';
  const val = (filter.campaign_id ?? filter.automation_id)!;
  const c = async (f: (q: any) => any) => { const { count } = await f(db.from('mailing_sends').select('id', { count: 'exact', head: true }).eq(key, val)); return count ?? 0; };
  const [total, queued, sent, delivered, failed, bounced, complained, skipped, opened, clicked, unsubscribed] = await Promise.all([
    c((q) => q), c((q) => q.in('status', ['queued', 'sending'])), c((q) => q.in('status', ['sent', 'delivered', 'bounced', 'complained'])), c((q) => q.eq('status', 'delivered')),
    c((q) => q.eq('status', 'failed')), c((q) => q.eq('status', 'bounced')), c((q) => q.eq('status', 'complained')), c((q) => q.eq('status', 'skipped')),
    c((q) => q.not('opened_at', 'is', null)), c((q) => q.not('clicked_at', 'is', null)), c((q) => q.not('unsubscribed_at', 'is', null)),
  ]);
  const rate = (n: number) => (sent ? Math.round((n / sent) * 1000) / 10 : 0);
  return { total, queued, sent, delivered, failed, bounced, complained, skipped, opened, clicked, unsubscribed,
    openRate: rate(opened), clickRate: rate(clicked), bounceRate: rate(bounced), unsubscribeRate: rate(unsubscribed) };
}

export async function topLinks(campaignId: string) {
  const sends = await allRows<{ id: string }>((f, t) => db.from('mailing_sends').select('id').eq('campaign_id', campaignId).not('clicked_at', 'is', null).range(f, t));
  const counts = new Map<string, { clicks: number; people: Set<string> }>();
  for (const part of chunk(sends.map((s) => s.id), 300)) {
    const { data } = await db.from('mailing_events').select('url, send_id').eq('type', 'click').in('send_id', part);
    for (const e of data ?? []) { const x = counts.get(e.url) ?? { clicks: 0, people: new Set() }; x.clicks++; x.people.add(e.send_id); counts.set(e.url, x); }
  }
  return [...counts.entries()].map(([url, x]) => ({ url, clicks: x.clicks, people: x.people.size })).sort((a, b) => b.clicks - a.clicks).slice(0, 20);
}

/** Double opt-in email for the public sign-up form. */
export async function sendConfirmation(c: Pick<Contact, 'email' | 'first_name' | 'token'>) {
  const inner = `<h1>Confirm your subscription</h1><p>Hi ${esc(c.first_name || 'there')}, please confirm you want to get emails from RentCreeb.</p>
<p><a class="btn" href="${links.confirm(c.token)}">Yes, subscribe me</a></p><p style="color:#5b6680">If you didn't ask for this, ignore this email and you won't hear from us.</p>`;
  await sendEmail(c.email, 'Please confirm your subscription', layout(inner, { kind: 'service' }));
}
