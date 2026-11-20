# RentCreeb: how the app works

<!--
This file is the RentCreeb Assistant's guide to the product. It ships with the backend.
Keep it current: when a feature changes, update the matching section in the same commit.
Numbers (fees, limits, prices, plans) are NOT written here: the assistant reads them live from the server settings
and database on every chat, so they are always right. Quick fixes and announcements belong in
Admin dashboard → Assistant → Knowledge (no deploy needed). The FAQ, support hours and screen list come from the app
itself (backend/assistant/app-facts.json, refreshed by `npm run assistant:sync`).
-->

## What RentCreeb is
A Nigerian (Lagos-first) rental marketplace and property-management app. Renters find verified homes, book paid
inspections, pay rent and save towards rent. Agents and landlords list properties. Landlords and estate managers
manage tenants, rent and repairs. Artisans (plumbers, electricians, carpenters…) get repair jobs. All money is in naira
and goes through Paystack; RentCreeb holds payments in escrow until the service happens.

## Account types (roles)
- **Tenant**: searches and saves properties, books inspections, chats with agents, pays rent, uses RentSave, reports repairs.
- **Agent**: lists properties for rent or sale; needs an active subscription plan to publish listings; hosts inspections and earns the inspection fee (minus the platform fee).
- **Landlord** and **Estate manager**: list and manage their own properties: units, tenants (including inviting tenants who don't have the app yet), rent collection and records, lease renewals and terminations, maintenance requests, posting repair jobs to artisans, documents.
- **Artisan**: applies with skills, service areas, ID, certificates, portfolio and references; after approval receives job alerts, sends quotes, diagnoses and does the work, gets paid from escrow, earns ratings.
- The role is chosen at sign-up and cannot be changed in the app; support can help if someone needs a different role.

## Sign-up, sign-in and verification
- Sign up with email/phone and password, or Google. The phone number is confirmed with an SMS code (OTP).
- Identity verification = NIN (National Identification Number) + a selfie that is matched against the NIMC record. Settings → Identity Verification. Verified users get a badge.
- Verification is required for: booking inspections, publishing listings, receiving payouts and some other actions.
- A limited number of NIN attempts is allowed. Close matches and unclear selfies go to **manual review** by the RentCreeb team (the app shows "in review"); the user is notified of the outcome. Tips for a good selfie: daylight, face the camera, no glasses or hat, phone at eye level.
- One NIN can only be attached to one verified account.

## Finding a home (tenants)
- Search tab: filter by area, price, bedrooms, property type (apartment, duplex, bungalow, studio, terrace, self-contain, commercial, land). Listings show photos, sometimes video tours (YouTube, TikTok, etc.), amenities, security features, fees (caution, agency, inspection), nearby places, the agent's rating and reviews.
- Only approved listings appear. "Verified listing" badges mean RentCreeb checked the listing.
- Save properties with the heart; Saved can be organised into named collections and flags price drops.

## Search tools (tenants)
- **Map search**: Search → Map (or Home → Map search). Browse listings as price pins, or tap **Draw area** and draw around the neighbourhood you want.
- **Saved searches & alerts**: set filters (or draw an area), tap **Save search**. RentCreeb checks new listings every few minutes and sends a notification when one matches. Manage them in Home → Saved searches (switch alerts on/off, delete).
- **Find a roommate**: Home → Roommates. Create a roommate profile (need a room / have a room, areas, budget, move-in date, lifestyle), browse people (best matches first), send a request. Only verified users can send or accept requests; accepting opens a chat in Messages. Phone numbers stay private.

## Inspections (bookings)
1. On a property page, tap **Book Inspection**, pick a date and time, pay the inspection fee (Paystack). The booking is "paid".
2. The agent/landlord confirms it ("confirmed"). Chat with them opens once the inspection is confirmed.
3. At the property, the tenant shares their **inspection OTP** with the agent to confirm they attended. Never share it before arriving.
4. After the inspection the fee is released to the agent (minus the platform fee) and the tenant can leave a review.
- Unpaid bookings expire automatically. A booking can be paid later from My Bookings within a limited time.
- Cancel/reschedule from My Bookings: free inside the free-cancellation window, otherwise a small cancellation charge (both shown before confirming). If the host declines or cancels, the tenant is refunded.
- **Virtual inspection**: when booking, choose **Virtual** instead of In person. At the booked time either side taps **Start video walkthrough** on the booking (an in-app video call). The tenant confirms it happened (or the agent marks it done after a video call of at least 3 minutes), which releases the fee. Good for people outside Lagos.
- Agent didn't show up, or something felt wrong: open the booking → **Report agent**. RentCreeb investigates and refunds if the agent was at fault.

## Payments, escrow and wallet
- Payments: Paystack (card, bank transfer, USSD…). RentCreeb never stores card details.
- Escrow: inspection fees and artisan job payments are held until the service is done, then released.
- Agents, landlords and artisans have a **wallet**: released escrow, rent paid through the app and refunds land there. Withdraw to a saved Nigerian bank account (usually instant, up to 24 hours depending on the bank). A failed withdrawal is reversed back into the wallet.
- Transactions screen shows the full history with receipts.
- Never pay anyone outside the app: those payments aren't protected. This is the most common scam.

## Rent (tenants and landlords)
- A landlord/estate manager adds a tenancy (unit, rent, frequency yearly/quarterly/monthly, lease dates). Invited tenants are linked automatically when they sign up with the same email or phone.
- Tenants see rent due on the Rent dashboard and can pay in the app; landlords can also record cash/transfer payments, send reminders, renew or terminate leases (the tenant accepts a renewal in the app), and export reports.
- Rent not paid by the due date shows as overdue.

## Tenancy tools (Rent → "Instalments, agreement, bills & more"; landlords: tenant → "Agreement & checklist")
- **Rent in instalments**: a tenant on yearly or quarterly rent can ask to split the next rent into 2–12 monthly (or quarterly) parts. Nothing changes until the landlord approves. Once approved, each part appears as rent due and is paid like normal rent; the next full rent period is counted from the original due date. This is a payment plan agreed with the landlord, not a loan.
- **Tenancy agreement**: the landlord creates a digital agreement from RentCreeb's standard template (pre-filled with the tenancy: parties, address, rent, dates, caution deposit), edits or adds clauses, then signs and sends. The tenant reads it and signs (typing their full name) or asks for changes. Signed agreements download as PDF with a tamper-evident fingerprint. The template is a starting point, not legal advice.
- **Move-in / move-out checklist**: either side records each room's condition (good/fair/poor/damaged) with notes and photos, signs and sends; the other side signs or disputes. The move-out report starts from the move-in one so they can be compared, which settles caution-deposit disagreements. PDF available.
- **Bills & service charges**: landlords split estate costs (service charge, diesel, electricity, water, security, waste…) across a property's tenants, equally or by custom amounts. Tenants pay their share in the app (Bills screen) and it goes to the landlord's wallet; landlords can also record cash/transfer payments, waive a share, or send reminders.
- **Rental history & receipts** (tenants): every tenancy and rent payment on RentCreeb, with a downloadable receipt for each paid rent (including ones the landlord recorded) and a "rental reference" PDF to share with a future landlord.
- **Rental profile (tenant screening)**: a landlord or agent can ask an applicant who booked their listing, or their tenant, to share their RentCreeb rental profile. The tenant sees exactly what is shared and chooses to share or decline. It shows: identity and phone verification, rental history on RentCreeb, rent paid on time vs late, whether they save with RentSave, inspections completed and upheld complaints. It never shows NIN, phone, bank details or amounts. Shares last 30 days and the tenant can withdraw any time. Tenants can preview their own profile.

## RentSave (tenants)
- Save towards rent in scheduled amounts (daily, weekly or monthly) with a target and target date, optionally linked to a tenancy.
- Plans can be paused; savings can be applied to rent or withdrawn from the RentSave screen (conditions are shown before confirming).

## Maintenance and repairs
- Tenant: Maintenance → new request with category (plumbing, electrical, carpentry, painting, AC & cooling, general), description, photos, urgency. Track progress in the ticket.
- Landlord: reviews requests, sets priority, rejects with a reason or posts a **job** for artisans. Overdue tickets are escalated.
- Job flow: artisans see the job → send quotes → landlord accepts one and pays into escrow → artisan diagnoses and may submit a report with materials/labour (landlord approves, rejects or counters if it costs more than the quote) → work → landlord confirms completion → payment released to the artisan → both sides rate each other.
- Chat between landlord/tenant and the artisan opens once an artisan is assigned.

## Listing a property (agents, landlords, estate managers)
- Add Listing: details, location, photos (at least one; 5+ recommended; first photo is the cover), optional video tour links, amenities and pricing. Save as a draft any time.
- Publishing needs a verified identity; agents also need an active subscription with room in their plan's listing limit.
- New listings go to review: an automatic check (photos, details, owner standing), then approval. Owners see the review result and what to fix; rejected listings can be edited and resubmitted.
- Owners can pause, edit, or take down listings, see views and bookings (Analytics for agents).
- Landlords can also add private (unlisted) properties purely to manage tenants and rent.

## Agent subscriptions
- Agents choose a plan (monthly, or yearly at a discount). Plans differ by how many live listings they allow. When a subscription expires, the agent's listings stop showing in search until renewed.

## Messages, calls and support
- Messages: chats about bookings and repair jobs; photos and files can be sent; voice and video calls from a chat.
- Support conversations: requests sent from Contact Support or Report a Bug open as a "RentCreeb Support" conversation in Messages; the team replies there. When support closes it, the chat locks and a new request is needed.
- Notifications: in-app and push; preferences in Settings → Notification Settings.

## Reviews and reports
- Tenants review a property/agent after an inspection; artisans and landlords rate each other after jobs. Owners can reply. Reviews can be marked helpful or flagged.
- Report a user/agent from a booking or chat; evidence photos can be attached. RentCreeb investigates.

## Documents and privacy
- Documents: store leases, IDs, receipts, utility bills, letters privately; optionally share with the landlord of a tenancy.
- Privacy Settings: marketing consent, activity status (online/typing), cookie preferences, request a copy of my data, delete account (wallet must be emptied and upcoming inspections finished or cancelled first).

## Safety rules the assistant always repeats when relevant
- Never share OTPs, passwords or card details with anyone, including someone claiming to be RentCreeb staff.
- Never pay outside the app. Inspect a property before paying rent.
- Report anything suspicious from the booking or chat.
