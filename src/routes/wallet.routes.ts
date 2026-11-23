import { Router } from 'express';
import { randomUUID } from 'crypto';
import { z } from 'zod';
import { db, unwrap } from '../lib/supabase';
import { paystack } from '../lib/paystack';
import { badRequest, forbidden, HttpError } from '../lib/errors';
import { fullName, kobo, paginate } from '../lib/common';
import { authenticate, requireVerified } from '../middleware/auth';
import { moneyLimit, payoutLimit } from '../middleware/moneyLimit';
import { createPayment } from '../services/payments';
import { env } from '../config/env';
import { notify } from '../services/notify';
import { logger } from '../lib/logger';

const DAY = 864e5;
/** Payout account changes and fresh card top-ups wait this long before they can be withdrawn (stolen-card / takeover guard). */
const HOLD_MS = DAY;

const r = Router();
r.use(authenticate, moneyLimit);

r.get('/', async (req, res) => {
  const { from, to } = paginate(req.query);
  const wallet = (await db.from('wallets').select('available_kobo').eq('user_id', req.user.id).single()).data;
  const { data: held } = await db.from('escrows').select('amount_kobo, fee_kobo').eq('payee_id', req.user.id).eq('status', 'held');
  const escrowKobo = (held ?? []).reduce((s, e) => s + Number(e.amount_kobo) - Number(e.fee_kobo), 0);
  const { data: txs } = await db.from('wallet_transactions').select('*').eq('user_id', req.user.id).order('created_at', { ascending: false }).range(from, to);
  const bank = (await db.from('bank_accounts').select('bank_name, account_number, account_name').eq('user_id', req.user.id).maybeSingle()).data;
  res.json({ availableKobo: wallet?.available_kobo ?? 0, inEscrowKobo: escrowKobo, bankAccount: bank, transactions: txs });
});

r.get('/banks', async (_req, res) => res.json({ banks: await paystack.listBanks() }));

/**
 * Add money to the wallet (any role). Card / bank transfer / USSD through Paystack; the wallet is credited when the
 * payment is confirmed (paymentProcessor.onWalletTopup). Identity verification and limits guard against stolen cards
 * being cashed out through withdrawals.
 */
r.post('/fund', requireVerified, async (req, res) => {
  const { amountKobo } = z.object({ amountKobo: kobo.min(env.WALLET_FUND_MIN_KOBO, `The minimum is ₦${(env.WALLET_FUND_MIN_KOBO / 100).toLocaleString('en-NG')}`)
    .max(env.WALLET_FUND_MAX_KOBO, `The maximum per top-up is ₦${(env.WALLET_FUND_MAX_KOBO / 100).toLocaleString('en-NG')}`) }).parse(req.body);
  if (amountKobo % 100) throw badRequest('Enter a whole naira amount');
  // Paid in the last 24 h, plus checkouts opened in the last 30 min (stops opening many at once to beat the limit).
  const [{ data: paid }, { data: open }] = await Promise.all([
    db.from('payments').select('amount_kobo').eq('user_id', req.user.id).eq('purpose', 'wallet_topup').eq('status', 'success').gte('paid_at', new Date(Date.now() - DAY).toISOString()),
    db.from('payments').select('amount_kobo').eq('user_id', req.user.id).eq('purpose', 'wallet_topup').eq('status', 'pending').gte('created_at', new Date(Date.now() - 30 * 60_000).toISOString()),
  ]);
  const used = [...(paid ?? []), ...(open ?? [])].reduce((s, p) => s + Number(p.amount_kobo), 0);
  if (used + amountKobo > env.WALLET_FUND_DAILY_KOBO) {
    const left = Math.max(0, env.WALLET_FUND_DAILY_KOBO - used);
    throw badRequest(left ? `You can add up to ₦${(left / 100).toLocaleString('en-NG')} more today` : 'You have reached today’s top-up limit. Try again tomorrow.', 'TOPUP_LIMIT');
  }
  const payment = await createPayment(req.user, 'wallet_topup', amountKobo);
  res.status(201).json({ payment });
});

r.put('/bank-account', payoutLimit, requireVerified, async (req, res) => {
  const b = z.object({ bankCode: z.string(), bankName: z.string().optional(), accountNumber: z.string().regex(/^\d{10}$/) }).parse(req.body);
  const { data: prev } = await db.from('bank_accounts').select('account_number, bank_code').eq('user_id', req.user.id).maybeSingle();
  const resolved = await paystack.resolveAccount(b.accountNumber, b.bankCode);
  const recipient = await paystack.createRecipient({ name: resolved.account_name, accountNumber: b.accountNumber, bankCode: b.bankCode });
  const changed = !!prev && (prev.account_number !== b.accountNumber || prev.bank_code !== b.bankCode);
  const base = { user_id: req.user.id, bank_code: b.bankCode, bank_name: b.bankName, account_number: b.accountNumber, account_name: resolved.account_name, paystack_recipient_code: recipient.recipient_code };
  let up = await db.from('bank_accounts').upsert({ ...base, ...(changed ? { changed_at: new Date().toISOString() } : {}) }).select('bank_name, account_number, account_name').single();
  // Before migration 029 there is no changed_at column: save the account anyway (the hold just can't apply yet).
  if (up.error && /changed_at/.test(up.error.message)) { logger.warn('bank_accounts.changed_at missing: run migration 029'); up = await db.from('bank_accounts').upsert(base).select('bank_name, account_number, account_name').single(); }
  const row = unwrap(up);
  if (changed) {
    // If this wasn't them, they hear about it straight away, and withdrawals are paused for 24 h.
    await notify(req.user.id, 'security', 'Payout account changed', `Withdrawals now go to ${resolved.account_name} (${b.bankName ?? 'bank'} ••••${b.accountNumber.slice(-4)}). For your safety, withdrawals are paused for 24 hours. If this wasn't you, contact support now.`, { wallet: true });
  }
  res.json({ bankAccount: row, withdrawalsPausedUntil: changed ? new Date(Date.now() + HOLD_MS).toISOString() : null });
});

/** Debit first (atomic, fails on insufficient funds), then transfer. Webhook reverses on failure. */
r.post('/withdraw', payoutLimit, requireVerified, async (req, res) => {
  const { amountKobo } = z.object({ amountKobo: kobo.min(100000) }).parse(req.body);
  const { data: bank } = await db.from('bank_accounts').select('*').eq('user_id', req.user.id).maybeSingle();
  if (!bank) throw badRequest('Add a bank account first', 'NO_BANK_ACCOUNT');
  if (bank.changed_at && Date.now() - Date.parse(bank.changed_at) < HOLD_MS) {
    const until = new Date(Date.parse(bank.changed_at) + HOLD_MS);
    throw forbidden(`Your payout account was changed recently. Withdrawals resume ${until.toLocaleString('en-NG', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })}.`, 'PAYOUT_ACCOUNT_HOLD');
  }
  // Money added by card in the last 24 h can be spent in the app but not withdrawn yet (card-fraud cash-out guard).
  const [{ data: w0 }, { data: recent }] = await Promise.all([
    db.from('wallets').select('available_kobo').eq('user_id', req.user.id).maybeSingle(),
    db.from('payments').select('amount_kobo').eq('user_id', req.user.id).eq('purpose', 'wallet_topup').eq('status', 'success').gte('paid_at', new Date(Date.now() - HOLD_MS).toISOString()),
  ]);
  const available = Number(w0?.available_kobo ?? 0);
  const onHold = Math.min(available, (recent ?? []).reduce((s, p) => s + Number(p.amount_kobo), 0));
  if (amountKobo > available - onHold) {
    throw forbidden(onHold ? `₦${(onHold / 100).toLocaleString('en-NG')} you added by card in the last 24 hours can't be withdrawn yet. You can withdraw up to ₦${(Math.max(0, available - onHold) / 100).toLocaleString('en-NG')} now.` : 'Insufficient balance', onHold ? 'TOPUP_HOLD' : 'INSUFFICIENT_FUNDS');
  }
  const reference = `RC_WD_${randomUUID().replace(/-/g, '').slice(0, 18)}`;
  const { error } = await db.rpc('wallet_debit', { p_user: req.user.id, p_amount: amountKobo, p_kind: 'withdrawal', p_desc: 'Withdrawal', p_ref: reference });
  if (error) throw error.message.includes('INSUFFICIENT_FUNDS') ? forbidden('Insufficient balance', 'INSUFFICIENT_FUNDS') : new HttpError(500, error.message);
  const w = unwrap(await db.from('withdrawals').insert({ user_id: req.user.id, amount_kobo: amountKobo, reference }).select().single());
  try {
    await paystack.transfer({ amountKobo, recipient: bank.paystack_recipient_code, reference, reason: `RentCreeb payout to ${fullName(req.user)}` });
  } catch (err) {
    // Refund only when Paystack clearly refused the transfer. A timeout / network error may still have gone through:
    // then the withdrawal stays pending and the transfer.success / transfer.failed webhook settles it (no double payout).
    if (err instanceof HttpError) {
      await db.from('withdrawals').update({ status: 'failed' }).eq('id', w.id).eq('status', 'pending');
      await db.rpc('wallet_credit', { p_user: req.user.id, p_amount: amountKobo, p_kind: 'withdrawal_reversal', p_desc: 'Withdrawal failed', p_ref: `wd-rev:${w.id}` });
      throw err;
    }
    logger.error({ err, withdrawal: w.id }, 'withdrawal transfer outcome unknown - waiting for Paystack webhook');
    return res.status(202).json({ withdrawal: w, message: 'Withdrawal is being processed. We will notify you when it completes.' });
  }
  res.status(202).json({ withdrawal: w, message: 'Withdrawal processing. Usually within 24 hours.' });
});

export default r;
