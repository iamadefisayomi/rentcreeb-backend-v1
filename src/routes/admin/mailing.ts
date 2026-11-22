import type { Router } from 'express';
import { z } from 'zod';
import { db, dbError, unwrap, unwrapMaybe } from '../../lib/supabase';
import { badRequest, notFound } from '../../lib/errors';
import { paginate, uuid } from '../../lib/common';
import { audit, dailySeries, like, sendCsv } from './shared';
import {
  assertReady, isEmail, mailStatus, normalizeEmail, queueCampaign, render, resolveAudience, resubscribeContact, sendStats,
  sendTest, syncAppUsers, topLinks, unsubscribeContact, type Audience, type Content,
} from '../../services/mailing';
import { STARTER_TEMPLATES } from '../../services/mailingStarters';

/**
 * Admin → Mailing: contacts, lists, templates, campaigns, automations, reports. See services/mailing.ts for the rules.
 */
const ROLES = ['tenant', 'landlord', 'estate_manager', 'artisan', 'agent', 'admin'] as const;
const audienceSchema = z.object({
  listIds: z.array(z.string().uuid()).default([]), tags: z.array(z.string().trim().min(1).max(40)).default([]), excludeTags: z.array(z.string().trim().min(1).max(40)).default([]),
  source: z.enum(['all', 'app_users', 'contacts']).default('all'), roles: z.array(z.enum(ROLES)).default([]), verification: z.enum(['any', 'verified', 'unverified']).default('any'),
});
const optEmail = z.string().trim().email().max(254).nullable().optional().or(z.literal('').transform(() => null));
const contentSchema = {
  subject: z.string().trim().max(200).default(''), preheader: z.string().trim().max(200).nullable().optional(),
  html: z.string().max(200_000).default(''), from_name: z.string().trim().max(80).nullable().optional(), reply_to: optEmail,
};
const campaignSchema = z.object({
  name: z.string().trim().min(1).max(120), kind: z.enum(['marketing', 'service']).default('marketing'), audience: audienceSchema.default({}), track: z.boolean().default(true), ...contentSchema,
});
const automationSchema = z.object({
  name: z.string().trim().min(1).max(120), trigger: z.enum(['user_signup', 'contact_added', 'list_joined']), list_id: z.string().uuid().nullable().optional(),
  roles: z.array(z.enum(ROLES)).default([]), delay_hours: z.number().int().min(0).max(8760).default(0), kind: z.enum(['marketing', 'service']).default('marketing'),
  ...contentSchema, subject: z.string().trim().min(1).max(200), html: z.string().min(1).max(200_000),
});
const tagList = (v: unknown) => [...new Set((Array.isArray(v) ? v : String(v ?? '').split(/[;,|]/)).map((t) => String(t).trim().toLowerCase()).filter(Boolean).slice(0, 30))];

/** Minimal RFC 4180 CSV reader (quotes, escaped quotes, CRLF). */
function parseCsv(text: string): string[][] {
  const rows: string[][] = []; let row: string[] = []; let cell = ''; let q = false;
  const s = text.replace(/^﻿/, '');
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (q) { if (ch === '"') { if (s[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += ch; continue; }
    if (ch === '"') q = true;
    else if (ch === ',' || ch === ';' || ch === '\t') { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && s[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim()));
}

async function listMemberCounts(ids: string[]) {
  const out: Record<string, number> = {};
  await Promise.all(ids.map(async (id) => { const { count } = await db.from('mailing_list_members').select('contact_id', { count: 'exact', head: true }).eq('list_id', id).eq('status', 'subscribed'); out[id] = count ?? 0; }));
  return out;
}
const MISSING = (e: any) => e?.code === 'PGRST205' || e?.code === '42P01' || /mailing_/i.test(e?.message ?? '') && /schema cache|does not exist/i.test(e?.message ?? '');

export function mountMailing(r: Router) {
  // ───────── overview ─────────
  r.get('/mailing/overview', async (_req, res) => {
    const probe = await db.from('mailing_contacts').select('id', { head: true, count: 'exact' }).limit(1);
    if (probe.error) { if (MISSING(probe.error)) return res.json({ available: false, status: mailStatus() }); throw dbError(probe.error); }
    const c = async (t: string, f?: (q: any) => any) => { let q: any = db.from(t).select('*', { count: 'exact', head: true }); if (f) q = f(q); const { count } = await q; return count ?? 0; };
    const since = new Date(Date.now() - 30 * 864e5).toISOString();
    const [total, subscribed, unsubscribed, pending, bounced, complained, appUsers, consented, lists, campaigns, automations, sent30, recent, growth, recentCampaigns] = await Promise.all([
      c('mailing_contacts'), c('mailing_contacts', (q) => q.eq('status', 'subscribed')), c('mailing_contacts', (q) => q.eq('status', 'unsubscribed')), c('mailing_contacts', (q) => q.eq('status', 'pending')),
      c('mailing_contacts', (q) => q.eq('status', 'bounced')), c('mailing_contacts', (q) => q.eq('status', 'complained')), c('mailing_contacts', (q) => q.not('user_id', 'is', null)),
      c('profiles', (q) => q.eq('privacy_prefs->>marketing', 'true').is('deleted_at', null)),
      c('mailing_lists'), c('mailing_campaigns'), c('mailing_automations', (q) => q.eq('active', true)), c('mailing_sends', (q) => q.gte('sent_at', since)),
      db.from('mailing_events').select('type, created_at').gte('created_at', since).limit(20000),
      db.from('mailing_contacts').select('created_at').gte('created_at', since).limit(20000),
      db.from('mailing_campaigns').select('id, name, status, kind, recipients, started_at, scheduled_at, finished_at').order('updated_at', { ascending: false }).limit(6),
    ]);
    const ev = recent.data ?? [];
    res.json({
      available: true, status: mailStatus(),
      contacts: { total, subscribed, unsubscribed, pending, bounced, complained, appUsers, marketingConsent: consented },
      lists, campaigns, activeAutomations: automations, sent30,
      trends: { newContacts: dailySeries(growth.data ?? [], 30), opens: dailySeries(ev.filter((e) => e.type === 'open'), 30), unsubscribes: dailySeries(ev.filter((e) => e.type === 'unsubscribe'), 30) },
      recentCampaigns: recentCampaigns.data ?? [],
    });
  });

  // ───────── contacts ─────────
  r.get('/mailing/contacts', async (req, res) => {
    const { from, to } = paginate(req.query);
    const f = z.object({ q: z.string().optional(), status: z.string().optional(), listId: z.string().uuid().optional(), tag: z.string().optional(), source: z.string().optional() }).parse(req.query);
    let sel = '*, members:mailing_list_members(list_id, status)';
    if (f.listId) sel = '*, members:mailing_list_members!inner(list_id, status)';
    let q = db.from('mailing_contacts').select(sel, { count: 'exact' }).order('created_at', { ascending: false }).range(from, to);
    if (f.listId) q = q.eq('members.list_id', f.listId);
    if (f.status) q = q.eq('status', f.status);
    if (f.source === 'app_users') q = q.not('user_id', 'is', null); else if (f.source) q = q.eq('source', f.source);
    if (f.tag) q = q.contains('tags', [f.tag.toLowerCase()]);
    if (f.q?.trim()) { const t = like(f.q); q = q.or(`email.ilike.${t},first_name.ilike.${t},last_name.ilike.${t}`); }
    const { data, count: total, error } = await q;
    if (error) throw dbError(error);
    res.json({ contacts: data, total: total ?? 0 });
  });
  r.get('/mailing/contacts.csv', async (req, res) => {
    const { status } = z.object({ status: z.string().optional() }).parse(req.query);
    let q = db.from('mailing_contacts').select('email, first_name, last_name, status, source, tags, user_id, created_at, unsubscribed_at, last_opened_at').order('created_at').limit(50000);
    if (status) q = q.eq('status', status);
    const { data, error } = await q;
    if (error) throw dbError(error);
    await audit(req, 'export.mailing_contacts', 'mailing', null, { rows: data?.length ?? 0, status: status ?? 'all' });
    sendCsv(res, `rentcreeb-contacts-${new Date().toISOString().slice(0, 10)}.csv`, (data ?? []).map((x: any) => ({ ...x, tags: (x.tags ?? []).join(';'), app_user: x.user_id ? 'yes' : 'no' })),
      [['email', 'Email'], ['first_name', 'First name'], ['last_name', 'Last name'], ['status', 'Status'], ['source', 'Source'], ['tags', 'Tags'], ['app_user', 'App user'], ['created_at', 'Added'], ['unsubscribed_at', 'Unsubscribed'], ['last_opened_at', 'Last opened']]);
  });
  r.get('/mailing/contacts/:id', async (req, res) => {
    const id = uuid.parse(req.params.id);
    const c = unwrapMaybe(await db.from('mailing_contacts').select('*, members:mailing_list_members(list_id, status, added_at, list:mailing_lists(name))').eq('id', id).maybeSingle());
    if (!c) throw notFound('Contact not found');
    const [{ data: sends }, { data: profile }] = await Promise.all([
      db.from('mailing_sends').select('id, status, sent_at, opened_at, clicked_at, error, campaign:mailing_campaigns(id, name), automation:mailing_automations(id, name)').eq('contact_id', id).order('created_at', { ascending: false }).limit(50),
      (c as any).user_id ? db.from('profiles').select('id, first_name, last_name, role, privacy_prefs').eq('id', (c as any).user_id).maybeSingle() : Promise.resolve({ data: null }),
    ]);
    res.json({ contact: c, sends: sends ?? [], profile });
  });
  r.post('/mailing/contacts', async (req, res) => {
    const b = z.object({ email: z.string().trim().max(254), first_name: z.string().trim().max(80).optional(), last_name: z.string().trim().max(80).optional(),
      tags: z.any().optional(), listIds: z.array(z.string().uuid()).default([]), status: z.enum(['subscribed', 'pending', 'unsubscribed']).default('subscribed') }).parse(req.body);
    const email = normalizeEmail(b.email);
    if (!isEmail(email)) throw badRequest('That is not a valid email address');
    const { data: exists } = await db.from('mailing_contacts').select('id').eq('email', email).maybeSingle();
    if (exists) throw badRequest('That email is already a contact', 'DUPLICATE');
    const contact = unwrap(await db.from('mailing_contacts').insert({ email, first_name: b.first_name || null, last_name: b.last_name || null, tags: tagList(b.tags), status: b.status, source: 'manual', consent_at: new Date().toISOString() }).select().single());
    if (b.listIds.length) await db.from('mailing_list_members').upsert(b.listIds.map((l) => ({ list_id: l, contact_id: contact.id })), { onConflict: 'list_id,contact_id' });
    await audit(req, 'mailing.contact_add', 'mailing_contact', contact.id, { email });
    res.status(201).json({ contact });
  });
  r.patch('/mailing/contacts/:id', async (req, res) => {
    const id = uuid.parse(req.params.id);
    const b = z.object({ first_name: z.string().trim().max(80).nullable().optional(), last_name: z.string().trim().max(80).nullable().optional(), tags: z.any().optional(),
      attributes: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])).optional(), status: z.enum(['subscribed', 'unsubscribed']).optional() }).parse(req.body);
    const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (b.first_name !== undefined) patch.first_name = b.first_name || null;
    if (b.last_name !== undefined) patch.last_name = b.last_name || null;
    if (b.tags !== undefined) patch.tags = tagList(b.tags);
    if (b.attributes) patch.attributes = b.attributes;
    unwrap(await db.from('mailing_contacts').update(patch).eq('id', id).select('id').single());
    if (b.status === 'unsubscribed') await unsubscribeContact(id, { reason: 'Unsubscribed by admin' });
    if (b.status === 'subscribed') await resubscribeContact(id);
    await audit(req, 'mailing.contact_edit', 'mailing_contact', id, b.status ? { status: b.status } : {});
    res.json({ ok: true });
  });
  /** Permanent erase (data-protection requests). App users are re-added by the next sync unless they delete their account. */
  r.delete('/mailing/contacts/:id', async (req, res) => {
    const id = uuid.parse(req.params.id);
    const { data: c } = await db.from('mailing_contacts').select('email').eq('id', id).maybeSingle();
    const { error } = await db.from('mailing_contacts').delete().eq('id', id);
    if (error) throw dbError(error);
    await audit(req, 'mailing.contact_delete', 'mailing_contact', id, { email: c?.email });
    res.status(204).end();
  });
  r.post('/mailing/contacts/bulk', async (req, res) => {
    const b = z.object({ ids: z.array(z.string().uuid()).min(1).max(1000), action: z.enum(['add_to_list', 'remove_from_list', 'add_tag', 'remove_tag', 'unsubscribe', 'resubscribe', 'delete']),
      listId: z.string().uuid().optional(), tag: z.string().trim().min(1).max(40).optional() }).parse(req.body);
    if ((b.action === 'add_to_list' || b.action === 'remove_from_list') && !b.listId) throw badRequest('Pick a list');
    if ((b.action === 'add_tag' || b.action === 'remove_tag') && !b.tag) throw badRequest('Enter a tag');
    const tag = b.tag?.toLowerCase();
    if (b.action === 'add_to_list') await db.from('mailing_list_members').upsert(b.ids.map((id) => ({ list_id: b.listId!, contact_id: id, status: 'subscribed' })), { onConflict: 'list_id,contact_id' });
    if (b.action === 'remove_from_list') await db.from('mailing_list_members').delete().eq('list_id', b.listId!).in('contact_id', b.ids);
    if (b.action === 'delete') await db.from('mailing_contacts').delete().in('id', b.ids);
    if (b.action === 'unsubscribe') for (const id of b.ids) await unsubscribeContact(id, { reason: 'Unsubscribed by admin' });
    if (b.action === 'resubscribe') for (const id of b.ids) await resubscribeContact(id);
    if (b.action === 'add_tag' || b.action === 'remove_tag') {
      const { data } = await db.from('mailing_contacts').select('id, tags').in('id', b.ids);
      for (const c of data ?? []) {
        const tags = b.action === 'add_tag' ? [...new Set([...(c.tags ?? []), tag!])] : (c.tags ?? []).filter((t: string) => t !== tag);
        await db.from('mailing_contacts').update({ tags }).eq('id', c.id);
      }
    }
    await audit(req, `mailing.bulk_${b.action}`, 'mailing', null, { count: b.ids.length, listId: b.listId, tag });
    res.json({ ok: true, count: b.ids.length });
  });
  /** CSV import. First row = headers; needs an "email" column. Other columns: first_name, last_name, tags; the rest become custom fields. */
  r.post('/mailing/contacts/import', async (req, res) => {
    const b = z.object({ csv: z.string().min(5).max(5_000_000), listId: z.string().uuid().optional(), tags: z.any().optional(),
      status: z.enum(['subscribed', 'pending']).default('subscribed'), updateExisting: z.boolean().default(true), consent: z.literal(true, { errorMap: () => ({ message: 'Confirm these people agreed to get your emails' }) }) }).parse(req.body);
    const rows = parseCsv(b.csv);
    if (rows.length < 2) throw badRequest('The file needs a header row and at least one contact');
    const head = rows[0].map((h) => h.trim().toLowerCase().replace(/[\s-]+/g, '_'));
    const col = (...names: string[]) => head.findIndex((h) => names.includes(h));
    const iEmail = col('email', 'email_address', 'e_mail'); const iFirst = col('first_name', 'firstname', 'first', 'name'); const iLast = col('last_name', 'lastname', 'last', 'surname'); const iTags = col('tags', 'tag');
    if (iEmail < 0) throw badRequest('No "email" column found in the first row');
    const extraTags = tagList(b.tags);
    const seen = new Set<string>(); const invalid: string[] = []; const items: any[] = [];
    for (const row of rows.slice(1)) {
      const email = normalizeEmail(row[iEmail] ?? '');
      if (!isEmail(email)) { if (email) invalid.push(email); continue; }
      if (seen.has(email)) continue; seen.add(email);
      const attributes: Record<string, string> = {};
      head.forEach((h, i) => { if (![iEmail, iFirst, iLast, iTags].includes(i) && h && row[i]?.trim()) attributes[h] = row[i].trim().slice(0, 500); });
      items.push({ email, first_name: iFirst >= 0 ? row[iFirst]?.trim() || null : null, last_name: iLast >= 0 ? row[iLast]?.trim() || null : null,
        tags: [...new Set([...extraTags, ...(iTags >= 0 ? tagList(row[iTags]) : [])])], attributes });
    }
    let added = 0, updated = 0, skipped = 0;
    const ids: string[] = [];
    for (let i = 0; i < items.length; i += 500) {
      const part = items.slice(i, i + 500);
      const { data: existing } = await db.from('mailing_contacts').select('id, email, tags, attributes, status').in('email', part.map((x) => x.email));
      const byEmail = new Map((existing ?? []).map((c: any) => [c.email, c]));
      const fresh = part.filter((x) => !byEmail.has(x.email)).map((x) => ({ ...x, source: 'import', status: b.status, consent_at: new Date().toISOString() }));
      if (fresh.length) { const ins = await db.from('mailing_contacts').insert(fresh).select('id'); if (ins.error) throw dbError(ins.error); added += ins.data.length; ids.push(...ins.data.map((x) => x.id)); }
      for (const x of part.filter((y) => byEmail.has(y.email))) {
        const c: any = byEmail.get(x.email); ids.push(c.id);
        // Never re-subscribe someone who unsubscribed, bounced or complained.
        if (!b.updateExisting) { skipped++; continue; }
        await db.from('mailing_contacts').update({ first_name: x.first_name ?? undefined, last_name: x.last_name ?? undefined, tags: [...new Set([...(c.tags ?? []), ...x.tags])],
          attributes: { ...(c.attributes ?? {}), ...x.attributes }, updated_at: new Date().toISOString() }).eq('id', c.id);
        updated++;
      }
    }
    if (b.listId && ids.length) for (let i = 0; i < ids.length; i += 500) await db.from('mailing_list_members').upsert(ids.slice(i, i + 500).map((id) => ({ list_id: b.listId!, contact_id: id })), { onConflict: 'list_id,contact_id', ignoreDuplicates: true });
    await audit(req, 'mailing.import', 'mailing', b.listId ?? null, { added, updated, skipped, invalid: invalid.length });
    res.json({ added, updated, skipped, invalid: invalid.length, invalidSample: invalid.slice(0, 10) });
  });
  r.post('/mailing/sync-users', async (req, res) => {
    const out = await syncAppUsers();
    await audit(req, 'mailing.sync_users', 'mailing', null, out);
    res.json(out);
  });

  // ───────── lists ─────────
  r.get('/mailing/lists', async (_req, res) => {
    const { data, error } = await db.from('mailing_lists').select('*').order('name');
    if (error) throw dbError(error);
    const counts = await listMemberCounts((data ?? []).map((l) => l.id));
    res.json({ lists: (data ?? []).map((l) => ({ ...l, members: counts[l.id] ?? 0 })) });
  });
  const listSchema = z.object({ name: z.string().trim().min(1).max(80), description: z.string().trim().max(300).nullable().optional(), is_public: z.boolean().default(false), double_opt_in: z.boolean().default(true) });
  r.post('/mailing/lists', async (req, res) => {
    const b = listSchema.parse(req.body);
    const { data, error } = await db.from('mailing_lists').insert(b).select().single();
    if (error) throw error.code === '23505' ? badRequest('A list with that name already exists') : dbError(error);
    await audit(req, 'mailing.list_create', 'mailing_list', data.id, { name: b.name });
    res.status(201).json({ list: data });
  });
  r.patch('/mailing/lists/:id', async (req, res) => {
    const b = listSchema.partial().parse(req.body);
    const { data, error } = await db.from('mailing_lists').update(b).eq('id', uuid.parse(req.params.id)).select().single();
    if (error) throw error.code === '23505' ? badRequest('A list with that name already exists') : dbError(error);
    res.json({ list: data });
  });
  r.delete('/mailing/lists/:id', async (req, res) => {
    const id = uuid.parse(req.params.id);
    const { error } = await db.from('mailing_lists').delete().eq('id', id);
    if (error) throw dbError(error);
    await audit(req, 'mailing.list_delete', 'mailing_list', id);
    res.status(204).end();
  });

  // ───────── templates ─────────
  r.get('/mailing/templates', async (_req, res) => {
    const { data, error } = await db.from('mailing_templates').select('*').order('updated_at', { ascending: false });
    if (error) throw dbError(error);
    res.json({ templates: data });
  });
  const templateSchema = z.object({ name: z.string().trim().min(1).max(120), subject: z.string().trim().max(200).default(''), preheader: z.string().trim().max(200).nullable().optional(), html: z.string().max(200_000).default('') });
  r.post('/mailing/templates', async (req, res) => {
    const b = templateSchema.parse(req.body);
    res.status(201).json({ template: unwrap(await db.from('mailing_templates').insert({ ...b, created_by: req.user.id }).select().single()) });
  });
  /** Adds the built-in starter templates (services/mailingStarters.ts). Skips any whose name already exists, so it's safe to press twice. */
  r.post('/mailing/templates/starters', async (req, res) => {
    const { data: existing, error } = await db.from('mailing_templates').select('name');
    if (error) throw dbError(error);
    const have = new Set((existing ?? []).map((t) => t.name.trim().toLowerCase()));
    const fresh = STARTER_TEMPLATES.filter((t) => !have.has(t.name.toLowerCase())).map((t) => ({ ...t, created_by: req.user.id }));
    if (fresh.length) { const ins = await db.from('mailing_templates').insert(fresh); if (ins.error) throw dbError(ins.error); }
    await audit(req, 'mailing.templates_starters', 'mailing', null, { added: fresh.length });
    res.json({ added: fresh.length, skipped: STARTER_TEMPLATES.length - fresh.length });
  });
  r.patch('/mailing/templates/:id', async (req, res) => {
    const b = templateSchema.partial().parse(req.body);
    res.json({ template: unwrap(await db.from('mailing_templates').update({ ...b, updated_at: new Date().toISOString() }).eq('id', uuid.parse(req.params.id)).select().single()) });
  });
  r.delete('/mailing/templates/:id', async (req, res) => {
    const { error } = await db.from('mailing_templates').delete().eq('id', uuid.parse(req.params.id));
    if (error) throw dbError(error);
    res.status(204).end();
  });

  // ───────── preview / test ─────────
  r.post('/mailing/preview', async (req, res) => {
    const b = z.object({ kind: z.enum(['marketing', 'service']).default('marketing'), ...contentSchema }).parse(req.body);
    const sample = { email: 'ada@example.com', first_name: 'Ada', last_name: 'Okafor', attributes: { city: 'Lagos' }, token: 'preview' };
    const out = render({ ...b, track: false } as Content, sample);
    res.json(out);
  });
  r.post('/mailing/test', async (req, res) => {
    const b = z.object({ to: z.array(z.string().trim().email()).min(1).max(5), kind: z.enum(['marketing', 'service']).default('marketing'), ...contentSchema }).parse(req.body);
    try { await sendTest({ ...b, track: false } as Content, b.to); } catch (e: any) { throw badRequest(e.message, 'MAIL_NOT_READY'); }
    res.json({ ok: true });
  });
  r.post('/mailing/estimate', async (req, res) => {
    const b = z.object({ audience: audienceSchema.default({}), kind: z.enum(['marketing', 'service']).default('marketing') }).parse(req.body);
    const { eligible, matched, excluded } = await resolveAudience(b.audience as Audience, b.kind);
    res.json({ recipients: eligible.length, matched, excluded, sample: eligible.slice(0, 8).map((c) => ({ email: c.email, first_name: c.first_name })) });
  });

  // ───────── campaigns ─────────
  r.get('/mailing/campaigns', async (req, res) => {
    const { from, to } = paginate(req.query);
    const { status } = z.object({ status: z.string().optional() }).parse(req.query);
    let q = db.from('mailing_campaigns').select('id, name, kind, subject, status, recipients, scheduled_at, started_at, finished_at, created_at, updated_at', { count: 'exact' }).order('updated_at', { ascending: false }).range(from, to);
    if (status) q = q.eq('status', status);
    const { data, count: total, error } = await q;
    if (error) throw dbError(error);
    const withStats = await Promise.all((data ?? []).map(async (c) => (['sending', 'sent', 'paused', 'cancelled'].includes(c.status) ? { ...c, stats: await sendStats({ campaign_id: c.id }) } : c)));
    res.json({ campaigns: withStats, total: total ?? 0 });
  });
  r.get('/mailing/campaigns/:id', async (req, res) => {
    const id = uuid.parse(req.params.id);
    const c = unwrapMaybe(await db.from('mailing_campaigns').select('*, creator:profiles!mailing_campaigns_created_by_fkey(first_name, last_name)').eq('id', id).maybeSingle());
    if (!c) throw notFound('Campaign not found');
    const started = (c as any).status !== 'draft' && (c as any).status !== 'scheduled';
    res.json({ campaign: c, stats: started ? await sendStats({ campaign_id: id }) : null, links: started ? await topLinks(id) : [] });
  });
  r.get('/mailing/campaigns/:id/recipients', async (req, res) => {
    const id = uuid.parse(req.params.id);
    const { from, to } = paginate(req.query);
    const f = z.object({ status: z.string().optional(), engaged: z.enum(['opened', 'clicked', 'unsubscribed', 'not_opened']).optional(), q: z.string().optional() }).parse(req.query);
    let q = db.from('mailing_sends').select('id, email, status, error, sent_at, delivered_at, opened_at, open_count, clicked_at, click_count, unsubscribed_at, contact_id', { count: 'exact' }).eq('campaign_id', id).order('created_at').range(from, to);
    if (f.status) q = q.eq('status', f.status);
    if (f.engaged === 'opened') q = q.not('opened_at', 'is', null);
    if (f.engaged === 'not_opened') q = q.is('opened_at', null).in('status', ['sent', 'delivered']);
    if (f.engaged === 'clicked') q = q.not('clicked_at', 'is', null);
    if (f.engaged === 'unsubscribed') q = q.not('unsubscribed_at', 'is', null);
    if (f.q?.trim()) q = q.ilike('email', like(f.q));
    const { data, count: total, error } = await q;
    if (error) throw dbError(error);
    res.json({ recipients: data, total: total ?? 0 });
  });
  r.get('/mailing/campaigns/:id/recipients.csv', async (req, res) => {
    const id = uuid.parse(req.params.id);
    const { data, error } = await db.from('mailing_sends').select('email, status, error, sent_at, delivered_at, opened_at, open_count, clicked_at, click_count, unsubscribed_at').eq('campaign_id', id).order('created_at').limit(100000);
    if (error) throw dbError(error);
    await audit(req, 'export.mailing_recipients', 'mailing_campaign', id, { rows: data?.length ?? 0 });
    sendCsv(res, `campaign-${id.slice(0, 8)}-recipients.csv`, data ?? [], [['email', 'Email'], ['status', 'Status'], ['error', 'Error'], ['sent_at', 'Sent'], ['delivered_at', 'Delivered'], ['opened_at', 'First opened'], ['open_count', 'Opens'], ['clicked_at', 'First click'], ['click_count', 'Clicks'], ['unsubscribed_at', 'Unsubscribed']]);
  });
  r.post('/mailing/campaigns', async (req, res) => {
    const b = campaignSchema.parse(req.body);
    const campaign = unwrap(await db.from('mailing_campaigns').insert({ ...b, created_by: req.user.id }).select().single());
    await audit(req, 'mailing.campaign_create', 'mailing_campaign', campaign.id, { name: b.name });
    res.status(201).json({ campaign });
  });
  r.patch('/mailing/campaigns/:id', async (req, res) => {
    const id = uuid.parse(req.params.id);
    const cur = unwrapMaybe(await db.from('mailing_campaigns').select('status').eq('id', id).maybeSingle()) as any;
    if (!cur) throw notFound('Campaign not found');
    if (!['draft', 'scheduled'].includes(cur.status)) throw badRequest('Only drafts and scheduled campaigns can be edited. Duplicate it to send a new version.');
    const b = campaignSchema.partial().parse(req.body);
    res.json({ campaign: unwrap(await db.from('mailing_campaigns').update({ ...b, updated_at: new Date().toISOString() }).eq('id', id).select().single()) });
  });
  r.post('/mailing/campaigns/:id/duplicate', async (req, res) => {
    const c = unwrapMaybe(await db.from('mailing_campaigns').select('name, kind, subject, preheader, from_name, reply_to, html, audience, track').eq('id', uuid.parse(req.params.id)).maybeSingle()) as any;
    if (!c) throw notFound('Campaign not found');
    res.status(201).json({ campaign: unwrap(await db.from('mailing_campaigns').insert({ ...c, name: `${c.name} (copy)`.slice(0, 120), created_by: req.user.id }).select().single()) });
  });
  r.delete('/mailing/campaigns/:id', async (req, res) => {
    const id = uuid.parse(req.params.id);
    const cur = unwrapMaybe(await db.from('mailing_campaigns').select('status').eq('id', id).maybeSingle()) as any;
    if (cur && !['draft', 'cancelled'].includes(cur.status)) throw badRequest('Only drafts and cancelled campaigns can be deleted (sent campaigns keep their report).');
    await db.from('mailing_campaigns').delete().eq('id', id);
    res.status(204).end();
  });
  /** Send now (or schedule). Checks the campaign is complete and email is configured first. */
  r.post('/mailing/campaigns/:id/send', async (req, res) => {
    const id = uuid.parse(req.params.id);
    const b = z.object({ scheduledAt: z.string().datetime().nullable().optional() }).parse(req.body ?? {});
    const c = unwrapMaybe(await db.from('mailing_campaigns').select('*').eq('id', id).maybeSingle()) as any;
    if (!c) throw notFound('Campaign not found');
    if (!['draft', 'scheduled'].includes(c.status)) throw badRequest('This campaign has already been sent');
    if (!c.subject?.trim()) throw badRequest('Add a subject line first');
    if (!c.html?.trim()) throw badRequest('Write the email first');
    try { assertReady(); } catch (e: any) { throw badRequest(e.message, 'MAIL_NOT_READY'); }
    if (b.scheduledAt) {
      if (Date.parse(b.scheduledAt) < Date.now() + 60_000) throw badRequest('Pick a time at least a minute from now');
      await db.from('mailing_campaigns').update({ status: 'scheduled', scheduled_at: b.scheduledAt, updated_at: new Date().toISOString() }).eq('id', id);
      await audit(req, 'mailing.campaign_schedule', 'mailing_campaign', id, { at: b.scheduledAt });
      return res.json({ scheduled: true });
    }
    const n = await queueCampaign(id);
    if (!n) { await db.from('mailing_campaigns').update({ status: 'draft', started_at: null }).eq('id', id); throw badRequest('Nobody in this audience can receive it. Check the audience and consent.'); }
    await audit(req, 'mailing.campaign_send', 'mailing_campaign', id, { recipients: n, kind: c.kind });
    res.json({ recipients: n });
  });
  for (const action of ['pause', 'resume', 'cancel', 'unschedule'] as const) r.post(`/mailing/campaigns/:id/${action}`, async (req, res) => {
    const id = uuid.parse(req.params.id);
    const c = unwrapMaybe(await db.from('mailing_campaigns').select('status').eq('id', id).maybeSingle()) as any;
    if (!c) throw notFound('Campaign not found');
    const next: Record<string, [string[], string]> = { pause: [['sending'], 'paused'], resume: [['paused'], 'sending'], cancel: [['sending', 'paused', 'scheduled'], 'cancelled'], unschedule: [['scheduled'], 'draft'] };
    const [from, to] = next[action];
    if (!from.includes(c.status)) throw badRequest(`Can't ${action} a campaign that is ${c.status}`);
    await db.from('mailing_campaigns').update({ status: to, updated_at: new Date().toISOString(), ...(action === 'cancel' ? { finished_at: new Date().toISOString() } : {}), ...(action === 'unschedule' ? { scheduled_at: null } : {}) }).eq('id', id);
    if (action === 'cancel') await db.from('mailing_sends').update({ status: 'skipped', error: 'campaign cancelled' }).eq('campaign_id', id).eq('status', 'queued');
    await audit(req, `mailing.campaign_${action}`, 'mailing_campaign', id);
    res.json({ status: to });
  });

  // ───────── automations ─────────
  r.get('/mailing/automations', async (_req, res) => {
    const { data, error } = await db.from('mailing_automations').select('*, list:mailing_lists(name)').order('created_at', { ascending: false });
    if (error) throw dbError(error);
    res.json({ automations: await Promise.all((data ?? []).map(async (a) => ({ ...a, stats: await sendStats({ automation_id: a.id }) }))) });
  });
  r.post('/mailing/automations', async (req, res) => {
    const b = automationSchema.parse(req.body);
    if (b.trigger === 'list_joined' && !b.list_id) throw badRequest('Pick the list that starts this automation');
    const a = unwrap(await db.from('mailing_automations').insert({ ...b, created_by: req.user.id }).select().single());
    await audit(req, 'mailing.automation_create', 'mailing_automation', a.id, { name: b.name, trigger: b.trigger });
    res.status(201).json({ automation: a });
  });
  r.patch('/mailing/automations/:id', async (req, res) => {
    const id = uuid.parse(req.params.id);
    const b = automationSchema.partial().extend({ active: z.boolean().optional() }).parse(req.body);
    const cur = unwrapMaybe(await db.from('mailing_automations').select('active').eq('id', id).maybeSingle()) as any;
    if (!cur) throw notFound('Automation not found');
    if (b.active && !cur.active) { try { assertReady(); } catch (e: any) { throw badRequest(e.message, 'MAIL_NOT_READY'); } }
    // Switching on starts from now: people who triggered it earlier are not back-sent.
    const patch: Record<string, unknown> = { ...b, updated_at: new Date().toISOString(), ...(b.active && !cur.active ? { activated_at: new Date().toISOString() } : {}) };
    const a = unwrap(await db.from('mailing_automations').update(patch).eq('id', id).select().single());
    if (b.active !== undefined && b.active !== cur.active) await audit(req, `mailing.automation_${b.active ? 'on' : 'off'}`, 'mailing_automation', id);
    if (b.active === false) await db.from('mailing_sends').update({ status: 'skipped', error: 'automation switched off' }).eq('automation_id', id).eq('status', 'queued');
    res.json({ automation: a });
  });
  r.delete('/mailing/automations/:id', async (req, res) => {
    const id = uuid.parse(req.params.id);
    await db.from('mailing_automations').delete().eq('id', id);
    await audit(req, 'mailing.automation_delete', 'mailing_automation', id);
    res.status(204).end();
  });
}
