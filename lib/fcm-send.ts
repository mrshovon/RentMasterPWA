// FCM (Firebase Cloud Messaging) sender for the native Android app. Web browsers keep
// using Web Push (see push-send.ts); Android `device_tokens` rows (device_type='android',
// FCM registration token, null p256dh/auth) are delivered here.
//
// Requires FIREBASE_SERVICE_ACCOUNT_JSON (the full service-account JSON as a single-line
// string) in the backend env. Without it, FCM is skipped (web push still works).
import { initializeApp, getApps, cert, type App } from 'firebase-admin/app';
import { getMessaging } from 'firebase-admin/messaging';
import { supabaseAdminEngine } from './supabase-server';
import type { PushPayload, PushAttempt, PushSound } from './push-send';
import { BRAND_PRIMARY } from './brand';

/**
 * The Android notification channel each sound preference maps to.
 *
 * ⚠️ Android FREEZES a channel's sound the moment the channel is created, and nothing — not an app
 * update, not the server — can change it afterwards. That is why there is one channel per option
 * instead of one channel whose sound we set per message, and why the ids carry a `_v1`: changing
 * the brand tone later means adding `bari360_tone_v2`, never editing this entry.
 *
 * The channels themselves are created by the app on launch — see lib/native-push.ts in the UI repo.
 * Keep the ids identical in both places or the notification lands on an auto-created channel with
 * default settings.
 *
 * 'off' is a channel at IMPORTANCE_LOW rather than a `silent` flag, because FCM has no such flag:
 * on Android 8+ the channel is the only thing that decides whether a notification makes a noise.
 */
const SOUND_CHANNELS: Record<PushSound, { channelId: string; sound?: string; defaultSound?: boolean }> = {
  custom:  { channelId: 'bari360_tone_v1',    sound: 'bari360_tone' },
  default: { channelId: 'bari360_default_v1', defaultSound: true },
  off:     { channelId: 'bari360_silent_v1' },
};

/**
 * Web Push endpoints are http(s) URLs; FCM registration tokens are not.
 *
 * ⚠️ Must NOT use `new URL(token)`. An FCM token is shaped `f1LOTYSdSam…:APA91b…`, and URL()
 * accepts ANY text before a colon as a scheme — so it parsed every FCM token as a valid URL
 * and this guard silently discarded 100% of native tokens, killing Android push entirely.
 * Match an explicit http/https scheme instead.
 */
function looksLikeWebPushEndpoint(token: string): boolean {
  return /^https?:\/\//i.test(token);
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
  // Belt and braces: a Web Push endpoint is an http(s) URL, an FCM token never is.
  // Sending one here would come back as `invalid-argument` and the pruning below would
  // DELETE a perfectly good browser subscription — which is precisely what used to happen
  // to every PWA installed on an Android phone. Drop them loudly instead.
  const stray = tokens.filter(looksLikeWebPushEndpoint);
  if (stray.length) {
    console.error(`[fcm] refusing ${stray.length} Web Push endpoint(s) routed to FCM — check the transport split in push-send.ts`);
  }
  const fcmTokens = tokens.filter((t) => !looksLikeWebPushEndpoint(t));

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
  const channel = SOUND_CHANNELS[payload.sound || 'custom'] ?? SOUND_CHANNELS.custom;

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
            // The house silhouette + brand tint. `color` OVERRIDES the installed APK's
            // values/colors.xml, so changing the brand here reaches devices that are still on an
            // older build — no app release needed. `icon` names a drawable that must exist in the
            // APK, so that one is only as new as the user's install.
            icon: 'ic_stat_notify',
            color: BRAND_PRIMARY,
            tag: payload.tag,
            // Sound comes from the channel (see SOUND_CHANNELS above). `sound` is still set for
            // the custom tone as a pre-Oreo fallback; on Android 8+ it is ignored in favour of
            // whatever the channel was created with.
            ...channel,
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
