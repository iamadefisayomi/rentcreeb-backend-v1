// Create (or promote) an admin manager account for the /admin dashboard (needs migration 030).
//
//   node scripts/create-admin-manager.mjs --email manager@rentcreeb.com --first Ada --last Obi [--password '…']
//
// A new account gets a confirmed email and the password you pass, or a random one that is printed once.
// An existing account with that email is switched to admin_manager (a full admin is never downgraded).
// What a manager can and can't do: src/routes/admin/access.ts.
import 'dotenv/config';
import { randomBytes } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';

const arg = (k) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : undefined; };
const email = arg('email')?.trim().toLowerCase();
const first = arg('first') || 'Admin';
const last = arg('last') || 'Manager';
if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { console.error('Usage: node scripts/create-admin-manager.mjs --email you@example.com [--first A --last B --password P]'); process.exit(1); }
const password = arg('password') || randomBytes(12).toString('base64url') + 'a1!';

const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

const { data: existing } = await db.from('profiles').select('id, role').ilike('email', email).maybeSingle();
let id = existing?.id;
if (existing?.role === 'admin') { console.log(`${email} is already a full admin; nothing changed.`); process.exit(0); }
if (!id) {
  const { data, error } = await db.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { first_name: first, last_name: last, role: 'tenant' } });
  if (error) { console.error('Could not create the sign-in:', error.message); process.exit(1); }
  id = data.user.id;
  for (let i = 0; i < 10; i++) { const { data: p } = await db.from('profiles').select('id').eq('id', id).maybeSingle(); if (p) break; await new Promise((r) => setTimeout(r, 300)); }
}
const { error } = await db.from('profiles').update({ role: 'admin_manager', first_name: first, last_name: last, updated_at: new Date().toISOString() }).eq('id', id);
if (error) { console.error('Could not set the role:', error.message, /check constraint/i.test(error.message) ? '\n→ Apply supabase/migrations/030_admin_manager_role.sql first.' : ''); process.exit(1); }
console.log(`Admin manager ready: ${email}`);
if (!existing) console.log(arg('password') ? 'Password: (the one you passed)' : `Temporary password: ${password}\nAsk them to change it after the first sign-in.`);
else console.log('Existing account promoted; their password is unchanged.');
