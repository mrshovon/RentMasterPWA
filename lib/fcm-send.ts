// FCM (Firebase Cloud Messaging) sender for the native Android app. Web browsers keep
// using Web Push (see push-send.ts); Android `device_tokens` rows (device_type='android',
// FCM registration token, null p256dh/auth) are delivered here.
//
// Requires FIREBASE_SERVICE_ACCOUNT_JSON (the full service-account JSON as a single-line
// string) in the backend env. Without it, FCM is skipped (web push still works).
import { initializeApp, getApps, cert, type App } from 'firebase-admin/app';
import { getMessaging } from 'firebase-admin/messaging';
import { supabaseAdminEngine } from './supabase-server';
import type { PushPayload } from './push-send';

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
export async function sendFcm(tokens: string[], payload: PushPayload): Promise<void> {
  const a = getApp();
  if (!a || tokens.length === 0) return;
  const messaging = getMessaging(a);
  const invalid: string[] = [];

  for (let i = 0; i < tokens.length; i += FCM_MULTICAST_LIMIT) {
    const chunk = tokens.slice(i, i + FCM_MULTICAST_LIMIT);
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
        if (r.success) return;
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
      });
    } catch (err) {
      console.error('[fcm] multicast failed:', err);
    }
  }

  if (invalid.length) {
    await supabaseAdminEngine.from('device_tokens').delete().in('token', invalid);
  }
}
