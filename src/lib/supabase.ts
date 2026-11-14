import { createClient } from '@supabase/supabase-js';
import { env } from '../config/env';
import { HttpError } from './errors';
import { logger } from './logger';

const opts = { auth: { persistSession: false, autoRefreshToken: false } };

/** Service-role client: bypasses RLS. Server-side only. */
export const db = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, opts);

/** Fresh anon client per call (sign-in/refresh mutate client session state). */
export const anonClient = () => createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, opts);

/** Result of an insert/update/select that must return data (`.single()`, `.select()`): throws if it didn't. */
type Res = { data: unknown; error: { message: string; code?: string } | null };

/**
 * A table/column the code expects is missing (migration not applied): PGRST205 = table not in PostgREST's
 * schema cache, PGRST204 = column not in cache, 42P01 / 42703 = undefined table / column in Postgres.
 */
const SCHEMA_MISSING = new Set(['PGRST205', 'PGRST204', '42P01', '42703']);

/** Turns a Supabase error into an HttpError. Schema gaps get a friendly 503 for users and a loud log for us. */
export function dbError(e: { message: string; code?: string }): HttpError {
  if (e.code && SCHEMA_MISSING.has(e.code)) {
    logger.error({ code: e.code, msg: e.message }, 'Database schema is missing a table/column — apply the pending migrations in backend/supabase/migrations');
    return new HttpError(503, 'This feature is still being set up. Please try again later.', 'FEATURE_UNAVAILABLE');
  }
  return new HttpError(500, e.message, 'DB_ERROR');
}

export function unwrap<R extends Res>(r: R): NonNullable<R['data']> {
  if (r.error) throw dbError(r.error);
  if (r.data == null) throw new HttpError(500, 'Expected a row but none was returned', 'DB_EMPTY');
  return r.data as NonNullable<R['data']>;
}

/** Like `unwrap`, for `.maybeSingle()` where "no row" is a normal outcome the caller handles. */
export function unwrapMaybe<R extends Res>(r: R): R['data'] | null {
  if (r.error) throw dbError(r.error);
  return r.data as R['data'] | null;
}
