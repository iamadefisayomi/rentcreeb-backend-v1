# RentCreeb admin dashboard

A plain HTML/CSS/JS page (no build step) served by the API at **`/admin`**,
e.g. `https://rentcreeb-backend-v1.onrender.com/admin`. It calls `/api/v1/admin/*` on the same server
(`src/routes/admin.routes.ts` → `src/routes/admin/{platform,people,content,money}.ts`).

## Setup

1. Apply the database updates in the Supabase SQL editor, in order, if you haven't:
   `011_admin_audit.sql`, `012_realtime_files_documents.sql`, **`013_admin_tools.sql`**.
   *System & settings* shows which ones are missing.
2. Give someone admin access, either from the dashboard (Users → person → Actions → Change role → Admin) or in SQL:

```sql
update profiles set role = 'admin' where email = 'person@example.com';
```

Anyone without the admin role is refused, both in the page and by the API. You can't change your own role or suspend yourself.

### Waitlist emails

- **Welcome email:** everyone who joins the waitlist on the website gets the **Waitlist welcome** email the moment they sign up (migration `032_waitlist_welcome.sql`).
  Edit the wording, or switch it off, in Mailing → Automations. If it's off, or email isn't set up, they get a short plain thank-you instead.
- **Updates to the whole waitlist:** Waitlist → **Email the waitlist** opens a new campaign aimed at everyone on the waitlist, including people who joined before the welcome email existed,
  pre-filled from the **Waitlist update** template. Any campaign can do the same: tick **Only people on the waitlist** in Audience and, if you like, pick waitlist statuses (e.g. only *Pending*).

### Deleting an account permanently

Users → person → Actions → **Delete permanently** (full admins only; needs migration `031_admin_delete_user.sql`). You type `DELETE` and a reason.
It removes the sign-in, profile, listings, chats, bookings, tenancies, maintenance requests, jobs, reviews, documents and uploaded photos,
including records shared with the other people involved. Payments and escrow rows are kept with the user unlinked, so finance totals don't change.
It runs as one database transaction and is refused while money is in motion: a wallet or RentSave balance, held escrow, a pending withdrawal,
an active tenancy, or a paid or confirmed booking. Full admins can't be deleted until their role is changed. The audit log keeps the name, email, phone and reason.
"Close account (anonymise)" is still there for when you want to keep the history.

### Admin managers (limited access)

Role `admin_manager` (needs migration `030_admin_manager_role.sql`) is for staff who run the day-to-day work but shouldn't hold every key.
Create one with `node scripts/create-admin-manager.mjs --email person@example.com --first Ada --last Obi`, or from Users → Change role → Admin manager.

- **Can:** overview (without money figures), search, ID verification, listings, artisans, reports, scam alerts, reviews, support chat, app feedback,
  users (view, edit profile, verify, suspend non-staff, message, password reset email), internal notes, waitlist (view), bookings / tenancies / jobs / RentSave (view only).
- **Can't:** finance, payments, escrow, withdrawals, subscriptions & plans, wallet credit/debit, cancelling or completing bookings, closing accounts, CSV exports,
  changing roles, editing or suspending other admins, reading private conversations, mailing, AI assistant setup, system & settings, announcements, audit log.

The API enforces this with an allow-list in `src/routes/admin/access.ts` (new admin routes stay admin-only until added there); the page hides what a manager can't use.

## What it does

| Section | What admins can do |
| --- | --- |
| **Overview** | Every queue with counts, platform numbers, 30-day sign-up and payment charts, recent admin activity |
| **System & settings** | Maintenance mode switch and message, in-app banner, live health of the database, SMS, Bytid, Paystack, the TURN call relay, email and storage, migration checklist, admin team |
| **ID verification** | Review queue for close face matches and manual requests: the selfie and ID photo side by side, account name vs the name on the NIMC record, date of birth, attempt history, a warning if the NIN is used by another account. Approve, reject (optionally giving attempts back), reset attempts |
| **Listings** | Approve or reject (one by one or in bulk), take down or restore, set any status, give or remove the verified badge, full detail with photos, units, bookings, reviews and tenancies |
| **Artisans** | Documents (signed links), portfolio, references; approve, send back, withdraw approval |
| **Reports** | Status and internal note, tell the reporter the outcome, repeat-offender count, read the related chat, suspend the reported user |
| **Reviews** | Hide or show, clear flags on reviews that are fine |
| **Support** | Filter by kind or search; reply as a notification; data requests link to the account |
| **App feedback** | Average rating, distribution, comments |
| **Users** | Search, filter, sort, CSV export. Per person: account and sign-in info, wallet and payout account, verification history, listings, bookings, payments, withdrawals, subscriptions, tenancies, jobs, tickets, reviews, reports, conversations, internal notes. Actions: edit profile, change role, message (in-app, push, email), password reset email, verify, revoke verification, reset attempts, mark phone verified, credit or debit the wallet, give a plan, suspend (also blocks sign-in) or lift, close the account |
| **Finance** | Gross payments, revenue (plans + escrow fees), money held for users (escrow, wallets, withdrawals in progress), by purpose, per day |
| **Payments** | Filter by status, purpose, date; CSV export; detail; re-check stuck payments with Paystack |
| **Bookings** | Detail with payment, escrow and chat; cancel with full or partial refund; mark done and pay the host |
| **Escrow** | Release to the payee, or refund the payer in full or in part |
| **Withdrawals** | Resolve ones stuck at pending: mark sent, or failed (money goes back to the wallet) |
| **Subscriptions & plans** | Edit or create plans (price, period, listing limit, on sale); extend, cancel or give plans |
| **Tenancies / Jobs / RentSave** | Oversight: leases with overdue rent, rent history, maintenance; jobs with quotes, escrow, photos and chat; savings plans |
| **Announcements** | Send a notification (and optional email) to everyone or chosen roles / verification states, with a recipient count first; history |
| **Audit log** | Every admin action, filterable by type or target |

## Automatic listing review (AI)

`src/services/listingReview.ts`, run every minute by the scheduler, up to `AI_MAX_RPM` (36) reviews a minute, `AI_CONCURRENCY` (6) at a time (needs migration `014_listing_ai_review.sql` and `NVIDIA_API_KEY`).
A listing waiting for approval is checked once it has been unchanged for 2 minutes, and again whenever it changes:

- **Rules:** the owner is verified, active and has no open reports; at least 3 photos, all uploaded in the app (not from other websites) and not used by another listing; no phone numbers, emails or links in the text; a description of at least 60 characters; price within 0.35× to 3× of similar live listings; not a duplicate.
- **AI** (one request with the text and up to 4 photos): genuine and consistent photos, text matching the type and bedrooms, scam signs, a plausible price.
- It **auto-approves** only when every rule passes and the AI approves with at least 80% confidence. Otherwise it stays pending with the reasons shown on the listing. It never rejects.
- Switch auto-approval off in *System & settings*. Run the check by hand from a listing's page. Auto-approvals appear in the audit log as "RentCreeb AI".
- Use another provider by setting `AI_API_KEY`, `AI_BASE_URL` and `AI_MODEL` (any OpenAI-compatible API whose model accepts images). If NVIDIA is busy or throttles, the listing is retried on the next runs (3 tries per version) before it is left for an admin.

## How ID evidence is handled

- The selfie is only kept when a person needs to look at it (a close match, a mismatch, or a manual request), in the **private** Bunny zone.
- People can attach a photo of their NIN slip, ID card, passport, driver's licence or voter's card when they ask for manual review (app: Verifying → Request Manual Review).
- Admins see it through 10-minute signed links. Every view is written to the audit log.
- Evidence is deleted as soon as an admin approves or rejects, and a daily job deletes anything older than 30 days that is no longer under review.
- Only the last 3 digits of the NIN and its hash are stored, plus the name on the NIMC record for comparison.

Update the privacy policy to say that selfies and ID photos may be kept for up to 30 days for manual review.

## Security notes

- The session is kept in `sessionStorage`, so it ends when the tab closes.
- The page has its own strict Content-Security-Policy (scripts only from this server) and is `noindex`. Admin API responses are `no-store`.
- All user-supplied text is escaped before it's shown; CSV exports neutralise spreadsheet formulas.
- Reading a private conversation asks for a reason, which is saved in the audit log.
- Every change an admin makes is written to `admin_actions` with who, what and when.
- Maintenance mode blocks the app API but keeps `/admin`, sign-in and `/users/me` open so admins can keep working.
