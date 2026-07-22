// FCM (Firebase Cloud Messaging) sender for the native Android app. Web browsers keep
// using Web Push (see push-send.ts); Android `device_tokens` rows (device_type='android',
// FCM registration token, null p256dh/auth) are delivered here.
//
// Requires FIREBASE_SERVICE_ACCOUNT_JSON (the full service-account JSON as a single-line
// string) in the backend env. Without it, FCM is skipped (web push still works).
import { initializeApp, getApps, cert, type App } from 'firebase-admin/app';
import { getMessaging } from 'firebase-admin/messaging';
import { supabaseAdminEngine } from './supabase-server';
import type { PushPayload, PushAttempt } from './push-send';

/** Web Push endpoints are URLs; FCM registration tokens never are. */
function looksLikeUrl(token: string): boolean {
  try { return !!new URL(token).protocol; } catch { return false; }
}

let app: App | null = null;
let initTried = false;

function getApp(): App | null {
  if (app) return app;
  if (initTried) return null;
  initTried = true;
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (!raw) {
    console.warn('[fcm] FIREBASE_SERVICE_ACCOUNT_JSON not set — skipping native (Android) push.');
    return null;
  }
  try {
    const creds = JSON.parse(raw);
    app = getApps().length ? getApps()[0] : initializeApp({ credential: cert(creds) });
    return app;
  } catch (err) {
    console.error('[fcm] invalid FIREBASE_SERVICE_ACCOUNT_JSON:', err);
    return null;
  }
}

const FCM_MULTICAST_LIMIT = 500;

/** Deliver a push to native Android FCM tokens; prunes tokens FCM reports as dead. */
export async function sendFcm(tokens: string[], payload: PushPayload): Promise<PushAttempt[]> {
  // Belt and braces: a Web Push endpoint is a URL, an FCM registration token never is.
  // Sending one here would come back as `invalid-argument` and the pruning below would
  // DELETE a perfectly good browser subscription — which is precisely what used to happen
  // to every PWA installed on an Android phone. Drop them loudly instead.
  const stray = tokens.filter(looksLikeUrl);
  if (stray.length) {
    console.error(`[fcm] refusing ${stray.length} Web Push endpoint(s) routed to FCM — check the transport split in push-send.ts`);
  }
  const fcmTokens = tokens.filter((t) => !looksLikeUrl(t));

  const a = getApp();
  if (!a || fcmTokens.length === 0) {
    return fcmTokens.map((t) => ({
      transport: 'fcm' as const,
      endpointHost: '(native token)',
      ok: false,
      error: 'FIREBASE_SERVICE_ACCOUNT_JSON not configured on the server',
    }));
  }
  const messaging = getMessaging(a);
  const invalid: string[] = [];
  const attempts: PushAttempt[] = [];

  for (let i = 0; i < fcmTokens.length; i += FCM_MULTICAST_LIMIT) {
    const chunk = fcmTokens.slice(i, i + FCM_MULTICAST_LIMIT);
    try {
      const res = await messaging.sendEachForMulticast({
        tokens: chunk,
        notification: { title: payload.title, body: payload.body },
        // Data mirrors PushPayload so the app can deep-link on tap (see lib/native-push.ts).
        data: { url: payload.url || '/', tag: payload.tag || '' },
        android: {
          priority: 'high',
          notification: {
            // The logo silhouette + brand tint (see AndroidManifest default meta-data).
            icon: 'ic_stat_notify',
            color: '#6366f1',
            tag: payload.tag,
            defaultSound: true,
          },
        },
      });
      res.responses.forEach((r, idx) => {
        if (r.success) {
          attempts.push({ transport: 'fcm', endpointHost: '(native token)', ok: true });
          return;
        }
        const code = r.error?.code || '';
        if (
          code.includes('registration-token-not-registered') ||
          code.includes('invalid-registration-token') ||
          code.includes('invalid-argument')
        ) {
          invalid.push(chunk[idx]);
        } else {
          console.error('[fcm] send error:', code, r.error?.message);
        }
        attempts.push({
          transport: 'fcm',
          endpointHost: '(native token)',
          ok: false,
          error: `${code || 'error'}: ${r.error?.message || 'send failed'}`,
        });
      });
    } catch (err: any) {
      console.error('[fcm] multicast failed:', err);
      for (const _ of chunk) {
        attempts.push({
          transport: 'fcm', endpointHost: '(native token)', ok: false,
          error: err?.message || 'multicast failed',
        });
      }
    }
  }

  if (invalid.length) {
    await supabaseAdminEngine.from('device_tokens').delete().in('token', invalid);
  }

  for (const _ of stray) {
    attempts.push({
      transport: 'fcm', endpointHost: '(web endpoint)', ok: false,
      error: 'Web Push endpoint was routed to FCM — not sent, not pruned',
    });
  }
  return attempts;
}
