import { env } from '../config/env';
import { db } from '../lib/supabase';
import { logger } from '../lib/logger';

/**
 * Runtime switches stored in app_settings (migration 013), editable from the admin dashboard.
 * Cached for 30 s so the maintenance check costs nothing per request. Missing table → env defaults.
 */
export type Banner = { message: string; tone: 'info' | 'warning' | 'success'; until?: string | null } | null;
export type Settings = { maintenanceMode: boolean; maintenanceMessage: string; banner: Banner };

const DEFAULTS = (): Settings => ({
  maintenanceMode: env.MAINTENANCE_MODE,
  maintenanceMessage: 'RentCreeb is under maintenance. Please try again shortly.',
  banner: null,
});

let cache: { at: number; value: Settings } | null = null;

export async function getSettings(fresh = false): Promise<Settings> {
  if (!fresh && cache && Date.now() - cache.at < 30_000) return cache.value;
  const value = DEFAULTS();
  const { data, error } = await db.from('app_settings').select('key, value');
  if (error) { if (!cache) logger.debug({ err: error }, 'app_settings unavailable (apply migration 013)'); }
  else for (const row of data ?? []) {
    if (row.key === 'maintenance_mode') value.maintenanceMode = env.MAINTENANCE_MODE || row.value === true;
    if (row.key === 'maintenance_message' && typeof row.value === 'string' && row.value.trim()) value.maintenanceMessage = row.value;
    if (row.key === 'banner') value.banner = row.value && typeof row.value === 'object' && (row.value as any).message ? row.value as Banner : null;
  }
  if (value.banner?.until && Date.parse(value.banner.until) < Date.now()) value.banner = null;
  cache = { at: Date.now(), value };
  return value;
}

export async function setSetting(key: 'maintenance_mode' | 'maintenance_message' | 'banner', value: unknown, adminId: string) {
  // `value` is NOT NULL in the table: clearing a setting (e.g. removing the banner) deletes its row instead.
  const { error } = value == null
    ? await db.from('app_settings').delete().eq('key', key)
    : await db.from('app_settings').upsert({ key, value, updated_by: adminId, updated_at: new Date().toISOString() });
  if (error) throw error;
  cache = null;
}
