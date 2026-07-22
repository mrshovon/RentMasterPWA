// Notification fan-out. Browser subscriptions go out over Web Push (VAPID, no Firebase);
// native Android subscriptions go out over FCM (see fcm-send.ts).
// Both read from the same `device_tokens` table. Callers use one API (sendPushToUsers/Role).
import webpush from 'web-push';
import { supabaseAdminEngine } from './supabase-server';
import { sendFcm } from './fcm-send';

const VAPID_PUBLIC = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY || '';
const VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY || '';
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || 'mailto:admin@pmp.com';

let configured = false;
function ensureConfigured(): boolean {
  if (configured) return true;
  if (!VAPID_PUBLIC || !VAPID_PRIVATE) {
    console.warn('[push] VAPID keys not configured — skipping push. Set NEXT_PUBLIC_VAPID_PUBLIC_KEY + VAPID_PRIVATE_KEY.');
    return false;
  }
  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC, VAPID_PRIVATE);
  configured = true;
  return true;
}

/** Whether Web Push can send at all. Surfaced by the diagnostics route. */
export const isWebPushConfigured = (): boolean => !!(VAPID_PUBLIC && VAPID_PRIVATE);

export interface PushPayload {
  title: string;
  body: string;
  url?: string;   // where notificationclick should navigate
  tag?: string;   // collapse key
}

interface TokenRow { token: string; p256dh: string | null; auth: string | null; device_type?: string | null; }

// ---------------------------------------------------------------------------
// Diagnostics. Every send collects per-token outcomes so /api/notifications/test
// can explain WHY nothing arrived instead of failing silently — which is exactly
// how two separate faults went unnoticed until users reported dead notifications.
// ---------------------------------------------------------------------------
export interface PushAttempt {
  transport: 'web' | 'fcm';
  /** Host only — never the full endpoint, which is a bearer-grade secret. */
  endpointHost: string;
  ok: boolean;
  error?: string;
}

export interface PushReport {
  /** false => VAPID env missing on this deployment; no browser push can be sent. */
  configured: boolean;
  tokens: number;
  attempts: PushAttempt[];
}

/** Host of a Web Push endpoint URL, for logging without leaking the endpoint itself. */
function hostOf(token: string): string {
  try { return new URL(token).host; } catch { return '(native token)'; }
}

/**
 * A row is Web Push if and only if it carries the ECDH crypto keys — that is what the
 * protocol requires and it cannot be faked by a label. Anything else is a native FCM
 * registration token.
 *
 * Deliberately NOT keyed off `device_type`: that column stores a CLIENT-SUPPLIED string,
 * and the browser used to send the operating system there, so a PWA on an Android phone
 * was tagged 'android' and routed to FCM — silently excluded from Web Push, and then
 * deleted by FCM's dead-token pruning. Transport is derived from the payload now.
 */
const isWebPushRow = (r: TokenRow): boolean => !!(r.p256dh && r.auth);

// Split rows by transport and deliver to each. Web + FCM run in parallel; a failure in one
// never blocks the other.
async function deliver(rows: TokenRow[], payload: PushPayload): Promise<PushReport> {
  const report: PushReport = { configured: isWebPushConfigured(), tokens: rows.length, attempts: [] };
  if (rows.length === 0) return report;

  const webRows = rows.filter(isWebPushRow);
  const nativeTokens = rows.filter((r) => !isWebPushRow(r)).map((r) => r.token);

  const [webAttempts, fcmAttempts] = await Promise.all([
    deliverWeb(webRows, payload),
    sendFcm(nativeTokens, payload),
  ]);
  report.attempts = [...webAttempts, ...fcmAttempts];
  return report;
}

async function deliverWeb(rows: TokenRow[], payload: PushPayload): Promise<PushAttempt[]> {
  if (rows.length === 0) return [];
  if (!ensureConfigured()) {
    return rows.map((r) => ({
      transport: 'web' as const,
      endpointHost: hostOf(r.token),
      ok: false,
      error: 'VAPID keys not configured on the server',
    }));
  }

  const body = JSON.stringify(payload);
  const staleEndpoints: string[] = [];

  const attempts = await Promise.all(
    rows.map(async (row): Promise<PushAttempt> => {
      const base = { transport: 'web' as const, endpointHost: hostOf(row.token) };
      const subscription = { endpoint: row.token, keys: { p256dh: row.p256dh!, auth: row.auth! } };
      try {
        await webpush.sendNotification(subscription, body);
        return { ...base, ok: true };
      } catch (err: any) {
        // 404/410 => subscription expired/unsubscribed; prune it.
        if (err?.statusCode === 404 || err?.statusCode === 410) {
          staleEndpoints.push(row.token);
          return { ...base, ok: false, error: `subscription expired (${err.statusCode})` };
        }
        console.error('[push] send failed:', err?.statusCode, err?.body || err?.message);
        // 403 here almost always means the VAPID keypair no longer matches the one the
        // subscription was created with (e.g. the keys were regenerated).
        return { ...base, ok: false, error: `${err?.statusCode ?? 'error'}: ${err?.body || err?.message || 'send failed'}` };
      }
    }),
  );

  if (staleEndpoints.length) {
    await supabaseAdminEngine.from('device_tokens').delete().in('token', staleEndpoints);
  }
  return attempts;
}

async function loadTokens(filter: (q: any) => any): Promise<TokenRow[]> {
  const { data } = await filter(
    supabaseAdminEngine.from('device_tokens').select('token, p256dh, auth, device_type'),
  );
  return (data as TokenRow[]) || [];
}

/** Push to specific users (owner uids or tenant ids), returning a delivery report. */
export async function sendPushReport(userIds: string[], payload: PushPayload): Promise<PushReport> {
  if (!userIds.length) return { configured: isWebPushConfigured(), tokens: 0, attempts: [] };
  return deliver(await loadTokens((q) => q.in('user_id', userIds)), payload);
}

/** Push to specific users (owner uids or tenant ids). */
export async function sendPushToUsers(userIds: string[], payload: PushPayload): Promise<void> {
  await sendPushReport(userIds, payload);
}

/** Broadcast to everyone with a given role ('tenant' | 'owner' | 'admin'). */
export async function sendPushToRole(role: 'tenant' | 'owner' | 'admin', payload: PushPayload): Promise<void> {
  await deliver(await loadTokens((q) => q.eq('role', role)), payload);
}
