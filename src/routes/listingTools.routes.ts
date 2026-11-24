import { Router, type Request } from 'express';
import PDFDocument from 'pdfkit';
import QRCode from 'qrcode';
import { db } from '../lib/supabase';
import { notFound, forbidden } from '../lib/errors';
import { uuid } from '../lib/common';
import { env } from '../config/env';
import { authenticate, optionalAuth } from '../middleware/auth';
import { comparablePrice, listingInsights, priceHistory, verdict } from '../services/listingInsights';

/**
 * Listing tools (mounted at /api/v1/listings) and the public share page (mounted at /p).
 *   GET  /listings/:id/price-insight   anyone: price history, latest drop, fair-price check
 *   GET  /listings/:id/insights        owner: views, saves, inspection requests, enquiries, price advice
 *   GET  /listings/:id/share           anyone: share link + QR image link
 *   GET  /listings/:id/poster.pdf      owner: printable "TO LET" sign with a QR code
 *   GET  /p/:id                        public web page for a shared link (opens the app, or shows the listing)
 *   GET  /p/:id/qr.png                 the QR code for that page
 */
export const listingTools = Router();
export const sharePages = Router();

const SELECT = 'id, owner_id, title, area, city, state, address, property_type, bedrooms, bathrooms, price_kobo, price_period, status, created_at, property_media(url, media_type, position)';
const naira = (k: number) => `₦${Math.round(Number(k) / 100).toLocaleString('en-NG')}`;
const per = (p: string) => (p === 'month' ? '/month' : p === 'year' ? '/year' : '');
const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const cover = (m: any[] | null | undefined) => [...(m ?? [])].filter((x) => x.media_type !== 'video').sort((a, b) => a.position - b.position)[0]?.url ?? null;

/** Public base for share links: this API's own address (Render sets it), so links work before the website has a page. */
const base = (req: Request) => env.API_PUBLIC_URL ?? `${req.protocol}://${req.get('host')}`;
export const shareUrl = (req: Request, id: string) => `${base(req)}/p/${id}`;

async function load(id: string) {
  const { data } = await db.from('properties').select(SELECT).eq('id', uuid.parse(id)).maybeSingle();
  if (!data) throw notFound('Listing not found');
  return data as any;
}

listingTools.get('/:id/price-insight', optionalAuth, async (req, res) => {
  const p = await load(String(req.params.id));
  if (p.status !== 'approved' && p.owner_id !== req.user?.id) throw notFound('Listing not found');
  const [{ history, lastDrop }, comp] = await Promise.all([priceHistory(p.id), comparablePrice(p)]);
  res.set('Cache-Control', 'private, max-age=300');
  res.json({ history, lastDrop, comparable: comp, verdict: verdict(comp) });
});

listingTools.get('/:id/insights', authenticate, async (req, res) => {
  const p = await load(String(req.params.id));
  if (p.owner_id !== req.user.id) throw forbidden();
  res.json({ insights: await listingInsights(p), share: { url: shareUrl(req, p.id), qr: `${shareUrl(req, p.id)}/qr.png` } });
});

listingTools.get('/:id/share', optionalAuth, async (req, res) => {
  const p = await load(String(req.params.id));
  if (p.status !== 'approved' && p.owner_id !== req.user?.id) throw notFound('Listing not found');
  const url = shareUrl(req, p.id);
  res.json({ url, qr: `${url}/qr.png`, message: `${p.title}, ${p.area ?? ''}: ${naira(p.price_kobo)}${per(p.price_period)} on RentCreeb\n${url}` });
});

listingTools.get('/:id/poster.pdf', authenticate, async (req, res) => {
  const p = await load(String(req.params.id));
  if (p.owner_id !== req.user.id) throw forbidden();
  const url = shareUrl(req, p.id);
  const qr = await QRCode.toBuffer(url, { width: 900, margin: 1, errorCorrectionLevel: 'M', color: { dark: '#0b1533', light: '#ffffff' } });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="to-let-${String(p.id).slice(0, 8)}.pdf"`);
  const doc = new PDFDocument({ size: 'A4', margin: 40 });
  doc.pipe(res);
  const W = doc.page.width;
  doc.rect(0, 0, W, 170).fill('#2E62FF');
  doc.fillColor('#fff').fontSize(78).font('Helvetica-Bold').text(p.price_period === 'outright' ? 'FOR SALE' : 'TO LET', 0, 42, { width: W, align: 'center' });
  doc.fillColor('#0b1533').fontSize(24).text(p.title, 40, 200, { width: W - 80, align: 'center' });
  doc.font('Helvetica').fontSize(15).fillColor('#444').text([p.area, p.city].filter(Boolean).join(', '), { width: W - 80, align: 'center' }).moveDown(0.3);
  doc.font('Helvetica-Bold').fontSize(30).fillColor('#2E62FF').text(`${naira(p.price_kobo)}${per(p.price_period)}`, { width: W - 80, align: 'center' });
  const size = 300; const x = (W - size) / 2; const y = doc.y + 24;
  doc.image(qr, x, y, { width: size, height: size });
  doc.font('Helvetica-Bold').fontSize(16).fillColor('#0b1533').text('Scan to see photos & book an inspection', 40, y + size + 18, { width: W - 80, align: 'center' });
  doc.font('Helvetica').fontSize(11).fillColor('#666').text(url, { width: W - 80, align: 'center' });
  doc.fontSize(10).fillColor('#888').text('Listed on RentCreeb · Verified agents & landlords · Never pay before inspecting', 40, doc.page.height - 70, { width: W - 80, align: 'center' });
  doc.end();
});

// ───────── Public share page ─────────
sharePages.get('/:id/qr.png', async (req, res) => {
  const id = uuid.parse(req.params.id);
  const png = await QRCode.toBuffer(shareUrl(req, id), { width: 600, margin: 2, errorCorrectionLevel: 'M', color: { dark: '#0b1533', light: '#ffffff' } });
  res.set({ 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=86400', 'Cross-Origin-Resource-Policy': 'cross-origin' });
  res.send(png);
});

sharePages.get('/:id', async (req, res) => {
  let p: any;
  try { p = await load(String(req.params.id)); } catch { p = null; }
  res.set({ 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'public, max-age=300' });
  // Inline styles only; this page lives outside the admin CSP.
  res.setHeader('Content-Security-Policy', "default-src 'none'; img-src https: data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'");
  if (!p || p.status !== 'approved') {
    return res.status(404).send(page('Listing not available', `<h1>This listing is no longer available</h1><p>It may have been rented out. Find similar homes on RentCreeb.</p><a class="btn" href="${esc(env.WEB_BASE_URL)}">Browse homes</a>`));
  }
  const img = cover(p.property_media);
  const title = `${p.title} · ${naira(p.price_kobo)}${per(p.price_period)}`;
  const specs = [p.bedrooms ? `${p.bedrooms} bed` : null, p.bathrooms ? `${p.bathrooms} bath` : null, p.property_type?.replace(/[-_]/g, ' ')].filter(Boolean).join(' · ');
  res.send(page(title, `
    ${img ? `<img class="hero" src="${esc(img)}" alt="">` : ''}
    <h1>${esc(p.title)}</h1>
    <p class="muted">${esc([p.area, p.city].filter(Boolean).join(', '))}</p>
    <p class="price">${esc(naira(p.price_kobo))}<span>${esc(per(p.price_period))}</span></p>
    ${specs ? `<p class="muted">${esc(specs)}</p>` : ''}
    <a class="btn" href="rentcreeb://property/${esc(p.id)}">Open in the RentCreeb app</a>
    <a class="btn ghost" href="${esc(env.WEB_BASE_URL)}">Get RentCreeb</a>
    <p class="note">Book inspections and pay only through RentCreeb. Never send money to anyone before you inspect.</p>`,
    { description: `${specs} in ${p.area ?? 'Lagos'} on RentCreeb`, image: img }));
});

function page(title: string, body: string, og: { description?: string; image?: string | null } = {}) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><meta property="og:title" content="${esc(title)}"><meta property="og:site_name" content="RentCreeb">
${og.description ? `<meta property="og:description" content="${esc(og.description)}">` : ''}${og.image ? `<meta property="og:image" content="${esc(og.image)}">` : ''}
<style>body{margin:0;font-family:-apple-system,Segoe UI,Roboto,sans-serif;background:#f5f7ff;color:#0b1533}
main{max-width:520px;margin:0 auto;padding:20px}.hero{width:100%;aspect-ratio:4/3;object-fit:cover;border-radius:18px}
h1{font-size:22px;margin:16px 0 4px}.muted{color:#5b6488;margin:4px 0}.price{font-size:26px;font-weight:800;color:#2E62FF;margin:10px 0}
.price span{font-size:14px;color:#5b6488;font-weight:600}.btn{display:block;text-align:center;background:#2E62FF;color:#fff;text-decoration:none;
font-weight:700;padding:15px;border-radius:14px;margin-top:12px}.btn.ghost{background:#fff;color:#2E62FF;border:1.5px solid #c5d4ff}
.note{font-size:12.5px;color:#5b6488;margin-top:18px;line-height:1.5}.brand{font-weight:800;color:#2E62FF;font-size:18px;margin-bottom:12px}</style></head>
<body><main><div class="brand">RentCreeb</div>${body}</main></body></html>`;
}
