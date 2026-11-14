import { createClient } from '@supabase/supabase-js';
import { env } from '../config/env';
import { HttpError } from './errors';

const opts = { auth: { persistSession: false, autoRefreshToken: false } };

/** Service-role client: bypasses RLS. Server-side only. */
export const db = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, opts);

/** Fresh anon client per call (sign-in/refresh mutate client session state). */
export const anonClient = () => createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, opts);

/** Result of an insert/update/select that must return data (`.single()`, `.select()`): throws if it didn't. */
type Res = { data: unknown; error: { message: string } | null };
export function unwrap<R extends Res>(r: R): NonNullable<R['data']> {
  if (r.error) throw new HttpError(500, r.error.message, 'DB_ERROR');
  if (r.data == null) throw new HttpError(500, 'Expected a row but none was returned', 'DB_EMPTY');
  return r.data as NonNullable<R['data']>;
}

/** Like `unwrap`, for `.maybeSingle()` where "no row" is a normal outcome the caller handles. */
export function unwrapMaybe<R extends Res>(r: R): R['data'] | null {
  if (r.error) throw new HttpError(500, r.error.message, 'DB_ERROR');
  return r.data as R['data'] | null;
}
