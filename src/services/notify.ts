import { Expo } from 'expo-server-sdk';
import { db } from '../lib/supabase';
import { logger } from '../lib/logger';

const expo = new Expo();

/** Preference keys shown in Settings → Notification Settings, with their defaults (Figma 4642:1008). */
export const NOTIFICATION_DEFAULTS = {
  all: true,
  inspection_confirmations: true, booking_reminders: true, cancellations: true,
  payment_confirmations: true, rentsave_deductions: true, escrow_updates: true, refund_status: true,
  ticket_status: true, artisan_assigned: true, repair_completed: false,
  new_messages: true, message_reminders: false,
  new_review: true, review_reminders: false,
  platform_updates: true, tips: false, promotions: false,
  channel_push: true, channel_email: true, channel_sms: false,
} as const;
export type NotificationPrefKey = keyof typeof NOTIFICATION_DEFAULTS;

/** Which preference gates the push for each notification type. Unlisted types always push. */
const TYPE_PREF: Record<string, NotificationPrefKey> = {
  booking_request: 'inspection_confirmations', booking_confirmed: 'inspection_confirmations', inspection_done: 'inspection_confirmations',
  booking_cancelled: 'cancellations',
  payment_success: 'payment_confirmations', rent_paid: 'payment_confirmations', rent_reminder: 'payment_confirmations',
  subscription_active: 'payment_confirmations', subscription_expired: 'payment_confirmations',
  rentsave: 'rentsave_deductions',
  payment_released: 'escrow_updates', revision_requested: 'escrow_updates', revision_approved: 'escrow_updates', revision_rejected: 'escrow_updates',
  maintenance_request: 'ticket_status', maintenance_update: 'ticket_status',
  new_quote: 'artisan_assigned', quote_accepted: 'artisan_assigned', job_started: 'artisan_assigned',
  job_complete: 'repair_completed',
  message: 'new_messages',
  new_review: 'new_review', review_reply: 'new_review',
  verified: 'platform_updates', tenancy_added: 'platform_updates', report_submitted: 'platform_updates',
};

/** Notification Center filter tabs. Types not listed fall under "account". */
export const NOTIFICATION_CATEGORIES = ['payments', 'bookings', 'maintenance', 'messages', 'reviews', 'account'] as const;
export type NotificationCategory = typeof NOTIFICATION_CATEGORIES[number];
const CATEGORY_TYPES: Record<Exclude<NotificationCategory, 'account'>, string[]> = {
  payments: ['payment_success', 'rent_paid', 'rent_reminder', 'subscription_active', 'subscription_expired', 'rentsave', 'payment_released', 'revision_requested', 'revision_approved', 'revision_rejected'],
  bookings: ['booking_request', 'booking_confirmed', 'booking_cancelled', 'inspection_done'],
  maintenance: ['maintenance_request', 'maintenance_update', 'maintenance_escalated', 'new_quote', 'quote_accepted', 'job_started', 'job_complete', 'report_submitted', 'report_approved', 'report_rejected', 'report_countered'],
  messages: ['message'],
  reviews: ['new_review', 'review_reply'],
};
export const categoryOf = (type: string): NotificationCategory =>
  (Object.keys(CATEGORY_TYPES) as (keyof typeof CATEGORY_TYPES)[]).find((c) => CATEGORY_TYPES[c].includes(type)) ?? 'account';
export const typesOf = (c: Exclude<NotificationCategory, 'account'>) => CATEGORY_TYPES[c];
export const knownTypes = () => Object.values(CATEGORY_TYPES).flat();

export const resolvePrefs = (stored: unknown) => ({ ...NOTIFICATION_DEFAULTS, ...((stored as object) ?? {}) }) as Record<NotificationPrefKey, boolean>;

/**
 * In-app notification + Expo push. Never throws.
 * The in-app inbox always records the notification; the user's preferences only decide whether it is pushed.
 */
export async function notify(userId: string, type: string, title: string, body: string, data: Record<string, unknown> = {}) {
  try {
    await db.from('notifications').insert({ user_id: userId, type, title, body, data });
    const { data: p } = await db.from('profiles').select('expo_push_token, notification_prefs').eq('id', userId).maybeSingle();
    const prefs = resolvePrefs(p?.notification_prefs);
    const gate = TYPE_PREF[type];
    if (!prefs.all || !prefs.channel_push || (gate && !prefs[gate])) return;
    const token = p?.expo_push_token;
    if (token && Expo.isExpoPushToken(token))
      // `type` rides along so the app can route a tapped push the same way as an in-app notification.
      await expo.sendPushNotificationsAsync([{ to: token, title, body, data: { ...data, type }, sound: 'default' }]);
  } catch (err) {
    logger.error({ err, userId, type }, 'notify failed');
  }
}
