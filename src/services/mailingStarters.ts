/**
 * Built-in starter templates for Admin → Mailing → Templates ("Add starter templates").
 * Bodies are HTML fragments: services/mailing.ts `layout()` adds the logo, card, footer and unsubscribe links.
 * Styles are inline because many email apps strip <style>. Merge tags: see `merge()` in services/mailing.ts.
 */
export type StarterTemplate = { name: string; subject: string; preheader: string; html: string };

const BTN = 'display:inline-block;background:#2563eb;color:#ffffff;text-decoration:none;padding:12px 22px;border-radius:9px;font-weight:600';
const MUTED = 'color:#5b6680;font-size:13px';
const button = (href: string, text: string) => `<p style="margin:22px 0"><a href="${href}" class="btn" style="${BTN}">${text}</a></p>`;
const box = (inner: string, bg = '#f4f6fb') => `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 16px"><tr><td style="background:${bg};border-radius:10px;padding:16px 18px">${inner}</td></tr></table>`;
const item = (title: string, text: string) => `<p style="margin:0 0 12px"><strong>${title}</strong><br>${text}</p>`;
/** A listing card with placeholder text the admin replaces before sending. */
const listing = (n: number) => box(
  `<p style="margin:0 0 4px;font-weight:700;font-size:16px">[Listing ${n} title, e.g. 2-bedroom flat, Yaba]</p>` +
  `<p style="margin:0 0 8px;${MUTED}">[Area, City] · [₦ price per year]</p>` +
  `<p style="margin:0"><a href="{{app_url}}" style="color:#2563eb;font-weight:600">View this home →</a></p>`);

export const STARTER_TEMPLATES: StarterTemplate[] = [
  {
    name: 'Welcome to RentCreeb',
    subject: 'Welcome to RentCreeb, {{first_name|there}} 👋',
    preheader: 'Find verified homes, trusted agents and reliable artisans, all in one app.',
    html: `<h1>Welcome to RentCreeb, {{first_name|there}}!</h1>
<p>We're glad you're here. RentCreeb makes renting in Nigeria simpler and safer, whether you're looking for a home, letting one out or offering your services.</p>
${box(item('🏠 Find a home', 'Browse listings with real photos, clear prices and verified landlords and agents.') +
  item('🛡️ Rent safely', 'Chat, call and pay inside the app so your money and details stay protected.') +
  item('🔧 Get things fixed', 'Book trusted artisans for plumbing, electrical work, cleaning and more.'))}
<p>Start by completing your profile and verifying your identity. Verified users get faster replies and more trust.</p>
${button('{{app_url}}', 'Open RentCreeb')}
<p>Questions? Just reply to this email. A real person will get back to you.</p>
<p>Welcome aboard,<br>The RentCreeb team</p>`,
  },
  {
    name: 'Monthly newsletter',
    subject: 'Your RentCreeb monthly: [Month] highlights',
    preheader: "What's new on RentCreeb, renting tips and homes worth a look this month.",
    html: `<h1>[Month] on RentCreeb</h1>
<p>Hi {{first_name|there}}, here's your roundup of what happened this month and what's coming next.</p>
<h2>📰 What's new</h2>
<p>[Two or three sentences about a new feature, a city you've launched in, or a milestone.]</p>
<h2>💡 Renting tip of the month</h2>
${box('<p style="margin:0">[A short, practical tip, e.g. "Always inspect a property in person, or by live video call in the app, before paying anything."]</p>')}
<h2>🏙️ Popular this month</h2>
<p>[One line about trending areas or prices, e.g. "Demand for self-contained flats in Ikeja rose 20% this month."]</p>
${button('{{app_url}}', 'See what’s new')}
<p>Until next month,<br>The RentCreeb team</p>`,
  },
  {
    name: 'New listings near you',
    subject: 'New homes just listed in {{attributes.city|your area}}',
    preheader: 'Fresh, verified listings picked for you. Good homes go fast.',
    html: `<h1>Fresh listings for you, {{first_name|there}}</h1>
<p>These homes were just added in {{attributes.city|your area}}. Good homes go fast, so take a look today.</p>
${listing(1)}
${listing(2)}
${listing(3)}
${button('{{app_url}}', 'Browse all listings')}
<p style="${MUTED}">Tip: save your search in the app and turn on notifications to hear about new homes first.</p>`,
  },
  {
    name: 'List your property (landlords & agents)',
    subject: 'Find good tenants faster with RentCreeb',
    preheader: 'List your property for free and reach verified tenants looking right now.',
    html: `<h1>Have a property to let, {{first_name|there}}?</h1>
<p>Thousands of renters search RentCreeb every week. List your property and reach verified tenants who are ready to move.</p>
${box(item('✅ Verified tenants', 'Every renter verifies their identity, so you know who you’re talking to.') +
  item('📸 Listings that stand out', 'Add photos, video and clear pricing in a few minutes.') +
  item('💬 Everything in one place', 'Chat, schedule inspections and manage enquiries right in the app.') +
  item('💳 Secure payments', 'Receive rent through the app with clear records for every payment.'))}
${button('{{app_url}}', 'List a property')}
<p>Managing several properties? Reply to this email and our team will help you get set up.</p>
<p>The RentCreeb team</p>`,
  },
  {
    name: 'Stay safe: avoid rental scams',
    subject: '5 ways to spot a rental scam',
    preheader: 'Never pay before you inspect. Here is how to protect yourself.',
    html: `<h1>Rent safely, {{first_name|there}}</h1>
<p>Rental scams are common, but they're easy to avoid once you know the signs. Here's how to protect yourself:</p>
${box(item('1. Never pay before you inspect', 'Visit the property in person or use a live video call in the app before sending any money.') +
  item('2. Keep chats and payments in RentCreeb', 'If someone asks you to move to WhatsApp or pay into a personal account, be careful.') +
  item('3. Watch for prices that are too good to be true', 'A much lower price than similar homes nearby is a common warning sign.') +
  item('4. Check for the verified badge', 'Verified landlords and agents have confirmed their identity with us.') +
  item('5. Don’t give in to pressure', 'Scammers often push you to "pay now before someone else does". Take your time.'), '#fff7ed')}
<p>If something feels wrong, report the listing or user from the app. Our team reviews every report.</p>
${button('{{app_url}}', 'Open RentCreeb')}
<p>Stay safe,<br>The RentCreeb team</p>`,
  },
  {
    name: 'New feature announcement',
    subject: 'New on RentCreeb: [feature name]',
    preheader: '[One line about what the new feature lets people do.]',
    html: `<p style="margin:0 0 8px"><span style="display:inline-block;background:#dbeafe;color:#1d4ed8;font-size:12px;font-weight:700;padding:4px 10px;border-radius:999px">NEW</span></p>
<h1>[Feature name] is here</h1>
<p>Hi {{first_name|there}}, we've just launched something we think you'll love.</p>
<p>[Two or three sentences explaining the feature and the problem it solves.]</p>
<h2>How it works</h2>
${box(item('1.', '[First step]') + item('2.', '[Second step]') + item('3.', '[Third step]'))}
${button('{{app_url}}', 'Try it now')}
<p style="${MUTED}">Update the app to the latest version if you don't see it yet.</p>
<p>The RentCreeb team</p>`,
  },
  {
    name: 'We miss you (re-engagement)',
    subject: "It's been a while, {{first_name|there}}",
    preheader: "Here's what you've missed on RentCreeb. New homes are waiting.",
    html: `<h1>We miss you, {{first_name|there}}</h1>
<p>It's been a while since you last visited RentCreeb, and a lot has changed:</p>
${box(item('🏠 More homes', 'New verified listings are added every day across more cities.') +
  item('📞 In-app calls', 'Talk to landlords and agents without sharing your phone number.') +
  item('🔧 Trusted artisans', 'Book vetted professionals for repairs and moving help.'))}
${button('{{app_url}}', 'Come back to RentCreeb')}
<p style="${MUTED}">Not interested any more? You can <a href="{{preferences_url}}" style="color:#5b6680">change what emails you get</a> or unsubscribe below.</p>`,
  },
];
