// Web Push (VAPID) sender — no Firebase. Reads subscriptions from `device_tokens` and
// delivers via the standard Web Push protocol using the `web-push` library.
import webpush from 'web-push';
import { supabaseAdminEngine } from './supabase-server';

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

export interface PushPayload {
  title: string;
  body: string;
  url?: string;   // where notificationclick should navigate
  tag?: string;   // collapse key
}

interface TokenRow { token: string; p256dh: string | null; auth: string | null; }

async function deliver(rows: TokenRow[], payload: PushPayload): Promise<void> {
  if (!ensureConfigured() || rows.length === 0) return;
  const body = JSON.stringify(payload);
  const staleEndpoints: string[] = [];

  await Promise.all(
    rows.map(async (row) => {
      if (!row.p256dh || !row.auth) return; // not a web-push subscription
      const subscription = { endpoint: row.token, keys: { p256dh: row.p256dh, auth: row.auth } };
      try {
        await webpush.sendNotification(subscription, body);
      } catch (err: any) {
        // 404/410 => subscription expired/unsubscribed; prune it.
        if (err?.statusCode === 404 || err?.statusCode === 410) {
          staleEndpoints.push(row.token);
        } else {
          console.error('[push] send failed:', err?.statusCode, err?.body || err?.message);
        }
      }
    }),
  );

  if (staleEndpoints.length) {
    await supabaseAdminEngine.from('device_tokens').delete().in('token', staleEndpoints);
  }
}

/** Push to specific users (owner uids or tenant ids). */
export async function sendPushToUsers(userIds: string[], payload: PushPayload): Promise<void> {
  if (!userIds.length) return;
  const { data } = await supabaseAdminEngine
    .from('device_tokens')
    .select('token, p256dh, auth')
    .in('user_id', userIds);
  await deliver((data as TokenRow[]) || [], payload);
}

/** Broadcast to everyone with a given role ('tenant' | 'owner' | 'admin'). */
export async function sendPushToRole(role: 'tenant' | 'owner' | 'admin', payload: PushPayload): Promise<void> {
  const { data } = await supabaseAdminEngine
    .from('device_tokens')
    .select('token, p256dh, auth')
    .eq('role', role);
  await deliver((data as TokenRow[]) || [], payload);
}
