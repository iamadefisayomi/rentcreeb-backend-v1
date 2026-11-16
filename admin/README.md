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
