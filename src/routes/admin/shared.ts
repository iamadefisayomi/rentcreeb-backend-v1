import type { Request, Response } from 'express';
import { z } from 'zod';
import { db } from '../../lib/supabase';
import { logger } from '../../lib/logger';

export const PERSON = 'id, first_name, last_name, email, phone, role, avatar_url';
export const decision = z.object({ approve: z.boolean(), reason: z.string().max(500).optional() });

/** Record who did what (best effort: a missing admin_actions table must not block moderation). */
export async function audit(req: Request, action: string, targetType: string, targetId: string | null, details: Record<string, unknown> = {}) {
  const { error } = await db.from('admin_actions').insert({ admin_id: req.user.id, action, target_type: targetType, target_id: targetId, details });
  if (error) logger.warn({ err: error, action }, 'admin audit write failed (apply migration 011)');
}

/** Exact row count for a filtered table; 0 if the table doesn't exist yet. */
export async function count(table: string, filter?: (q: any) => any) {
  let q: any = db.from(table).select('*', { count: 'exact', head: true });
  if (filter) q = filter(q);
  const { count: n, error } = await q;
  return error ? 0 : n ?? 0;
}

export const sumKobo = (rows: { amount_kobo?: number | string; fee_kobo?: number | string }[] | null, field: 'amount_kobo' | 'fee_kobo' = 'amount_kobo') =>
  (rows ?? []).reduce((t, x) => t + Number((x as any)[field] || 0), 0);

/** Safe ILIKE pattern for PostgREST .or() filters (commas and parentheses would break the filter syntax). */
export const like = (s: string) => `%${s.replace(/[%_,()*\\]/g, ' ').trim()}%`;

export const isUuid = (s: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);

/** Day buckets (Africa/Lagos) for the last `days` days, oldest first. */
export function dailySeries(rows: { created_at?: string; paid_at?: string | null; amount_kobo?: number | string }[], days: number, valueOf?: (r: any) => number) {
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Lagos', year: 'numeric', month: '2-digit', day: '2-digit' });
  const out: { day: string; value: number }[] = [];
  const index = new Map<string, number>();
  for (let i = days - 1; i >= 0; i--) { const d = fmt.format(new Date(Date.now() - i * 864e5)); index.set(d, out.length); out.push({ day: d, value: 0 }); }
  for (const r of rows) {
    const at = r.paid_at || r.created_at; if (!at) continue;
    const k = index.get(fmt.format(new Date(at)));
    if (k != null) out[k].value += valueOf ? valueOf(r) : 1;
  }
  return out;
}

/** Send rows as a CSV download (spreadsheet-safe: formulas are neutralised). */
export function sendCsv(res: Response, filename: string, rows: Record<string, unknown>[], columns: [string, string][]) {
  const cell = (v: unknown) => {
    let s = v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const body = [columns.map((c) => cell(c[1])).join(','), ...rows.map((r) => columns.map((c) => cell(c[0].split('.').reduce<any>((o, k) => o?.[k], r))).join(','))].join('\r\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Cache-Control', 'no-store');
  res.send('﻿' + body);
}

/** Internal notes on any record (migration 013). Returns [] when the table is missing. */
export async function notesFor(targetType: string, targetId: string) {
  const { data, error } = await db.from('admin_notes').select('id, body, created_at, admin:profiles!admin_notes_admin_id_fkey(first_name, last_name)')
    .eq('target_type', targetType).eq('target_id', targetId).order('created_at', { ascending: false }).limit(50);
  return error ? [] : data ?? [];
}
