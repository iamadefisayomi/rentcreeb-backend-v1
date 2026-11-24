import 'dotenv/config';
import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().default(4000),
  CORS_ORIGINS: z.string().default('*'),
  /** 'true' → every /api/v1 call returns 503 MAINTENANCE (webhooks + /health keep working). */
  MAINTENANCE_MODE: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),
  APP_BASE_URL: z.string().default('https://rentcreeb.com'),
  /** The rentcreeb.com website (Next.js). Email links, Google sign-in and Paystack return there. */
  WEB_BASE_URL: z.string().url().default('https://www.rentcreeb.com').transform((u) => u.replace(/\/+$/, '')),
  /** Inbox for the website's contact form and waitlist sign-ups. */
  WEB_CONTACT_EMAIL: z.string().email().default('enquiry@rentcreeb.com'),
  /** Extra website origins allowed as redirect targets (comma separated, e.g. Vercel preview URLs). */
  WEB_ORIGINS: z.string().optional(),

  SUPABASE_URL: z.string().url(),
  SUPABASE_ANON_KEY: z.string().min(1),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
  PASSWORD_RESET_REDIRECT_URL: z.string().min(1),

  OTP_PEPPER: z.string().min(16),
  // Optional secret for GET /api/v1/cron/keep-alive (send as Authorization: Bearer <token>).
  CRON_JOB_TOKEN: z.string().optional(),

  // SMS via SmartSMS Nigeria's JSON API (smartsms.ng). Username = your login email; API key from the dashboard.
  SMARTSMS_USERNAME: z.string().optional(),
  SMARTSMS_API_KEY: z.string().optional(),
  SMARTSMS_SENDER_ID: z.string().max(11).default('RentCreeb'),
  // Fallback provider: Africa's Talking (used only if SMARTSMS_TOKEN is not set).
  AT_USERNAME: z.string().default('sandbox'),
  AT_API_KEY: z.string().optional(),
  AT_SENDER_ID: z.string().optional(),

  // One URL for sandbox and live: a uvk_test_ key runs in sandbox, a uvk_live_ key runs live.
  BYTID_BASE_URL: z.string().url().default('https://api.bytid.com/v1').transform((u) => u.replace(/\/+$/, '')),
  BYTID_API_KEY: z.string().min(1),
  // Bytid's own "matched" verdict is trusted by default (0). Raise this only to be stricter than Bytid.
  BYTID_MIN_CONFIDENCE: z.coerce.number().default(0),
  // A "not_matched" scoring at least this high goes to manual review instead of failing (and doesn't use an attempt).
  BYTID_REVIEW_SCORE: z.coerce.number().default(45),
  NIN_MAX_ATTEMPTS: z.coerce.number().default(3),
  // Combined identity score (face 50 + first 12 + last 12 + middle 6 + date of birth 14 + gender 6) that is approved straight away.
  NIN_AUTO_APPROVE_SCORE: z.coerce.number().default(65),

  PAYSTACK_SECRET_KEY: z.string().min(1),
  PAYSTACK_CALLBACK_URL: z.string().optional(),

  /** Utility payments (airtime, data, electricity, TV…) via VTpass. Unset keys = the feature shows as "coming soon". */
  VTPASS_BASE_URL: z.string().url().default('https://sandbox.vtpass.com/api').transform((u) => u.replace(/\/+$/, '')),
  VTPASS_API_KEY: z.string().optional(),
  VTPASS_SECRET_KEY: z.string().optional(),
  VTPASS_PUBLIC_KEY: z.string().optional(),
  /** Convenience fee added to each electricity / TV / internet / exam purchase (not airtime or data). */
  UTILITY_FEE_KOBO: z.coerce.number().int().min(0).default(0),
  /** Bill purchases per 24 h for accounts without NIN verification (default ₦20,000). */
  UTILITY_UNVERIFIED_DAILY_KOBO: z.coerce.number().int().min(0).default(2_000_000),
  /** Wallet top-ups (any role): per top-up min / max and a rolling 24-hour total per user. Defaults ₦100 / ₦500,000 / ₦1,000,000. */
  WALLET_FUND_MIN_KOBO: z.coerce.number().int().min(100).default(10_000),
  WALLET_FUND_MAX_KOBO: z.coerce.number().int().min(100).default(50_000_000),
  WALLET_FUND_DAILY_KOBO: z.coerce.number().int().min(100).default(100_000_000),

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
  /** Public address of this API (links in emails: unsubscribe, tracking). Render sets RENDER_EXTERNAL_URL itself. */
  API_PUBLIC_URL: z.string().url().optional().transform((u) => (u ?? process.env.RENDER_EXTERNAL_URL)?.replace(/\/+$/, '')),
  /** Resend → Webhooks signing secret (whsec_…): delivery, bounce, complaint, open and click events. */
  RESEND_WEBHOOK_SECRET: z.string().optional(),
  /** Postal address shown in the footer of marketing emails (anti-spam laws require one). */
  MAIL_COMPANY_ADDRESS: z.string().default('RentCreeb, Lagos, Nigeria'),
  /** Mailing list send speed. Resend's default limit is 2 API calls/second; each batch call carries up to 100 emails. */
  MAIL_SENDS_PER_MINUTE: z.coerce.number().int().min(1).max(6000).default(600),

  /** VAT shown (as included in the price) on RentCreeb's own fees: subscriptions and inspection fees. 0 hides the line. */
  VAT_PCT: z.coerce.number().min(0).max(50).default(7.5),
  /** In-app calls: STUN servers (comma-separated) and an optional TURN relay for callers behind strict NATs. */
  STUN_URLS: z.string().default('stun:stun.l.google.com:19302,stun:stun1.l.google.com:19302'),
  TURN_URLS: z.string().optional(),
  TURN_USERNAME: z.string().optional(),
  TURN_CREDENTIAL: z.string().optional(),
  // Cloudflare Realtime TURN (recommended): dashboard → Realtime → TURN Server → create key.
  CF_TURN_KEY_ID: z.string().optional(),
  CF_TURN_API_TOKEN: z.string().optional(),

  // Claude (Anthropic API). When ANTHROPIC_API_KEY is set, the listing review uses Claude; otherwise the provider below.
  ANTHROPIC_API_KEY: z.string().optional(),
  CLAUDE_MODEL: z.string().default('claude-opus-5-5'),
  CLAUDE_EFFORT: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).default('medium'),
  /** RentCreeb Assistant (in-app help chat). Model defaults to CLAUDE_MODEL; chat replies do well at low effort (fast, cheaper). */
  ASSISTANT_MODEL: z.string().optional(),
  /** auto (default) = Claude if ANTHROPIC_API_KEY is set, else the AI_* provider (NVIDIA). Or force anthropic / openai. */
  ASSISTANT_PROVIDER: z.enum(['auto', 'anthropic', 'openai']).default('auto'),
  ASSISTANT_EFFORT: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).default('low'),

  // AI fallback (any OpenAI-compatible chat API; defaults to NVIDIA's free API at build.nvidia.com). Unset key = off.
  AI_API_KEY: z.string().optional(),
  NVIDIA_API_KEY: z.string().optional(),
  AI_BASE_URL: z.string().url().default('https://integrate.api.nvidia.com/v1').transform((u) => u.replace(/\/+$/, '')),
  /** Must accept images (listing photo checks). */
  AI_MODEL: z.string().default('nvidia/nemotron-3.5-super-vl-120b-a12b'),
  /** Requests per minute we allow ourselves. NVIDIA's free tier is ~40 for the whole account: 36 leaves room for retries. */
  AI_MAX_RPM: z.coerce.number().int().min(1).max(1000).default(36),
  /** Listing reviews run side by side (each takes 4-10 s), so the per-minute budget is actually used. */
  AI_CONCURRENCY: z.coerce.number().int().min(1).max(16).default(6),
  /** Auto-approve listings the AI review fully passes (admins can also switch this off in the dashboard). */
  LISTING_AUTO_APPROVE: z.enum(['true', 'false']).default('true').transform((v) => v === 'true'),

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
