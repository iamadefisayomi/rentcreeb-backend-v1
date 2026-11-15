# RentCreeb admin dashboard

A plain HTML/CSS/JS page (no build step) served by the API at **`/admin`**,
e.g. `https://rentcreeb-backend-v1.onrender.com/admin`. It calls `/api/v1/admin/*` on the same server.

## Give someone admin access

Admins sign in with a normal RentCreeb account (email + password) whose role is `admin`.
In the Supabase SQL editor:

```sql
update profiles set role = 'admin' where email = 'person@example.com';
```

To remove access, set the role back (e.g. `'tenant'`). Anyone without the admin role is refused, both in the page and by the API.

## What it does

| Section | Actions |
| --- | --- |
| Overview | Queue counts, platform numbers, recent admin activity |
| Listings | Approve / reject pending listings; take down or restore live ones |
| Artisan applications | View ID and certificates (signed 5-minute links), references, approve / send back |
| ID verifications | Approve or reject NIN checks that went to manual review |
| Reports | Change status with an internal note; suspend the reported user |
| Flagged reviews | Hide / show reviews |
| Support tickets | Change status and send the user a reply (as an in-app notification) |
| Users | Search and filter; profile, ID checks, listings, bookings, payments, reports; verify, suspend, lift suspension |
| Payments | Read-only list with filters |
| Audit log | Every admin action (needs migration `011_admin_audit.sql`) |

## Security notes

- The session is kept in `sessionStorage`, so it ends when the tab closes.
- The page has its own strict Content-Security-Policy (scripts only from this server) and is `noindex`.
- All user-supplied text is escaped before it's shown.
- Every change an admin makes is written to `admin_actions` with who, what and when.
