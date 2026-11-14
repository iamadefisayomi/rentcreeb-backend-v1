import 'dotenv/config';
import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().default(4000),
  CORS_ORIGINS: z.string().default('*'),
  /** 'true' → every /api/v1 call returns 503 MAINTENANCE (webhooks + /health keep working). */
  MAINTENANCE_MODE: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),
  APP_BASE_URL: z.string().default('https://rentcreeb.com'),

  SUPABASE_URL: z.string().url(),
  SUPABASE_ANON_KEY: z.string().min(1),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
  PASSWORD_RESET_REDIRECT_URL: z.string().min(1),

  OTP_PEPPER: z.string().min(16),

  AT_USERNAME: z.string().default('sandbox'),
  AT_API_KEY: z.string().optional(),
  AT_SENDER_ID: z.string().optional(),

  // One URL for sandbox and live: a uvk_test_ key runs in sandbox, a uvk_live_ key runs live.
  BYTID_BASE_URL: z.string().url().default('https://api.bytid.com/v1').transform((u) => u.replace(/\/+$/, '')),
  BYTID_API_KEY: z.string().min(1),
  BYTID_MIN_CONFIDENCE: z.coerce.number().default(70),
  NIN_MAX_ATTEMPTS: z.coerce.number().default(3),

  PAYSTACK_SECRET_KEY: z.string().min(1),
  PAYSTACK_CALLBACK_URL: z.string().optional(),

  BUNNY_STORAGE_HOST: z.string().default('storage.bunnycdn.com'),
  BUNNY_STORAGE_ZONE: z.string().min(1),
  BUNNY_STORAGE_KEY: z.string().min(1),
  // Trailing slashes are stripped: a doubled `//` breaks Bunny token signatures and path matching on delete.
  BUNNY_CDN_URL: z.string().url().transform((u) => u.replace(/\/+$/, '')),
  BUNNY_PRIVATE_STORAGE_ZONE: z.string().optional(),
  BUNNY_PRIVATE_STORAGE_KEY: z.string().optional(),
  BUNNY_PRIVATE_CDN_URL: z.string().optional().transform((u) => u?.replace(/\/+$/, '')),
  BUNNY_PRIVATE_TOKEN_KEY: z.string().optional(),

  RESEND_API_KEY: z.string().optional(),
  EMAIL_FROM: z.string().default('RentCreeb <no-reply@rentcreeb.com>'),
  /** Inbox that receives Contact Support / Report a Bug submissions (optional; tickets are always stored). */
  SUPPORT_EMAIL: z.string().email().optional(),

  INSPECTION_FEE_KOBO: z.coerce.number().default(500000),
  INSPECTION_PLATFORM_FEE_PCT: z.coerce.number().default(10),
  JOB_PLATFORM_FEE_PCT: z.coerce.number().default(5),
  BOOKING_CANCEL_CHARGE_PCT: z.coerce.number().default(10),
  BOOKING_FREE_CANCEL_HOURS: z.coerce.number().default(24),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  const lines = parsed.error.issues.map((i) => `  • ${i.path.join('.')}: ${i.message === 'Required' ? 'missing' : i.message}`);
  console.error(`\n✖ The API can't start: missing or invalid settings in .env\n\n${lines.join('\n')}\n\nCopy .env.example to .env and fill these in.\nWhile testing, the Bytid and Bunny values can be any placeholder text.\n`);
  process.exit(1);
}
export const env = parsed.data;
export const isProd = env.NODE_ENV === 'production';
