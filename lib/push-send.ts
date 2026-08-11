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

/**
 * Which sound a recipient's notifications make. Set per account in Settings → App & notifications
 * and stored in `notification_prefs` (see ADD_NOTIFICATION_PREFS.sql).
 *
 * Callers do NOT set this — `deliver()` fills it in per recipient. It is on the payload rather than
 * a separate argument because both transports need it: FCM turns it into an Android channel id
 * (fcm-send.ts) and Web Push carries it to the service worker, which uses it for `silent` and to
 * ask an open page to play the brand tone (app/sw.ts in the UI repo).
 */
export type PushSound = 'custom' | 'default' | 'off';
export const DEFAULT_PUSH_SOUND: PushSound = 'custom';

export interface PushPayload {
  title: string;
  body: string;
  url?: string;   // where notificationclick should navigate
  tag?: string;   // collapse key
  sound?: PushSound;  // filled in per recipient by deliver(); callers leave it unset
}

interface TokenRow {
  user_id: string;
  token: string;
  p256dh: string | null;
  auth: string | null;
  device_type?: string | null;
}

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

/**
 * Each recipient's chosen notification sound, keyed by the same id `device_tokens.user_id` uses
 * (an owner auth uid or a tenant id). Anyone without a row keeps the shipped default.
 *
 * Wrapped so a missing table is survivable: this file is on the path of EVERY notification in the
 * app, and a preference lookup must never be the reason a rent reminder fails to go out. Before
 * ADD_NOTIFICATION_PREFS.sql is run, PostgREST answers PGRST205 and everyone simply gets 'custom'.
 */
async function loadSoundPrefs(rows: TokenRow[]): Promise<Map<string, PushSound>> {
  const prefs = new Map<string, PushSound>();
  const userIds = [...new Set(rows.map((r) => r.user_id).filter(Boolean))];
  if (!userIds.length) return prefs;
  try {
    const { data, error } = await supabaseAdminEngine
      .from('notification_prefs')
      .select('user_id, sound')
      .in('user_id', userIds);
    if (error) throw error;
    for (const row of data || []) {
      if (row?.user_id && row?.sound) prefs.set(row.user_id, row.sound as PushSound);
    }
  } catch (err: any) {
    console.warn('[push] could not read notification_prefs — defaulting everyone to the app tone:', err?.message || err);
  }
  return prefs;
}

// Split rows by transport and deliver to each. Web + FCM run in parallel; a failure in one
// never blocks the other.
//
// Rows are first grouped by the recipient's sound preference, because that is a property of the
// message on the wire (an Android channel id, a `silent` flag) and not something the transports can
// decide for themselves. At most three groups exist, so this is at most three sends per transport.
async function deliver(rows: TokenRow[], payload: PushPayload): Promise<PushReport> {
  const report: PushReport = { configured: isWebPushConfigured(), tokens: rows.length, attempts: [] };
  if (rows.length === 0) return report;

  const prefs = await loadSoundPrefs(rows);
  const groups = new Map<PushSound, TokenRow[]>();
  for (const row of rows) {
    const sound = prefs.get(row.user_id) ?? DEFAULT_PUSH_SOUND;
    const group = groups.get(sound);
    if (group) group.push(row);
    else groups.set(sound, [row]);
  }

  const batches = await Promise.all(
    [...groups.entries()].map(async ([sound, groupRows]) => {
      const groupPayload: PushPayload = { ...payload, sound };
      const webRows = groupRows.filter(isWebPushRow);
      const nativeTokens = groupRows.filter((r) => !isWebPushRow(r)).map((r) => r.token);
      const [webAttempts, fcmAttempts] = await Promise.all([
        deliverWeb(webRows, groupPayload),
        sendFcm(nativeTokens, groupPayload),
      ]);
      return [...webAttempts, ...fcmAttempts];
    }),
  );

  report.attempts = batches.flat();
  await recordFailures(report, payload);
  return report;
}

/**
 * Write ONE aggregate log row per dispatch when deliveries failed — not one per token. A
 * broadcast to every owner would otherwise produce hundreds of near-identical rows and bury the
 * server errors the admin is actually looking for.
 *
 * Expired subscriptions are excluded: those are pruned automatically and are the normal cost of
 * people uninstalling the app, not a fault. What this is here to catch is the class of failure
 * that has already bitten twice — a VAPID keypair that no longer matches (403 on every send) and
 * a missing Firebase service account — both of which are invisible from the outside because push
 * is fire-and-forget everywhere it is called.
 */
async function recordFailures(report: PushReport, payload: PushPayload): Promise<void> {
  const failures = report.attempts.filter((a) => !a.ok && !/expired/.test(a.error || ''));
  if (!failures.length) return;

  const { logEvent } = await import('./logger');
  await logEvent({
    level: 'warn',
    source: 'push',
    message: `Push delivery failed for ${failures.length} of ${report.attempts.length} device(s): ${payload.title}`,
    detail: failures.map((f) => `${f.transport} ${f.endpointHost}: ${f.error}`).join('\n'),
    context: {
      configured: report.configured,
      tokens: report.tokens,
      failed: failures.length,
      title: payload.title,
    },
  });
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
    supabaseAdminEngine.from('device_tokens').select('user_id, token, p256dh, auth, device_type'),
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
