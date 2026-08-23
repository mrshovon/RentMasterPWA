import { NextResponse } from 'next/server';
import { supabaseAdminEngine } from '@/lib/supabase-server';

// Registers a push token for the authenticated user. Two shapes:
//   - Web Push (browser):  body.subscription = { endpoint, keys: { p256dh, auth } }
//   - Native FCM (Android): body.token = "<fcm token>", body.deviceDetails = "android"
// Identity is injected + verified by middleware (client-supplied identity headers are stripped there).
export async function POST(request: Request) {
  try {
    const userId = request.headers.get('x-rentmaster-uid') || request.headers.get('x-rentmaster-tenant-id');

    // device_tokens.role is what sendPushToRole() filters on with a plain .eq(), so a role it
    // does not know about is not an error — it is a device that silently receives nothing. A
    // building admin is an owner as far as broadcasts are concerned ("all owners" must reach
    // them), so it is normalised here rather than at every send site.
    const rawRole = request.headers.get('x-rentmaster-role') || null;
    const role = rawRole === 'building_admin' ? 'owner' : rawRole;
    if (!userId) {
      return NextResponse.json({ success: false, error: 'Unauthorized.' }, { status: 401 });
    }

    const body = await request.json();
    const deviceType = body?.deviceDetails || 'web';
    const sub = body?.subscription;
    const nativeToken: string | undefined = body?.token;

    let row: Record<string, any> | null = null;
    if (deviceType === 'android' && typeof nativeToken === 'string' && nativeToken) {
      // Native FCM token — no p256dh/auth (those are Web Push crypto keys).
      row = { user_id: userId, token: nativeToken, p256dh: null, auth: null, role, device_type: 'android' };
    } else if (sub?.endpoint && sub?.keys?.p256dh && sub?.keys?.auth) {
      // Standard Web Push subscription. device_type is forced to 'web' rather than echoing
      // the client's label: the presence of the ECDH keys IS the proof of transport, and the
      // browser used to send the operating system here — so an Android PWA was stored as
      // 'android' and later routed to FCM, which silently killed browser push on every
      // Android device. Transport is never taken from the client now.
      row = { user_id: userId, token: sub.endpoint, p256dh: sub.keys.p256dh, auth: sub.keys.auth, role, device_type: 'web' };
    }

    if (!row) {
      return NextResponse.json({ success: false, error: 'A valid push subscription or token is required.' }, { status: 400 });
    }

    const { error } = await supabaseAdminEngine
      .from('device_tokens')
      .upsert(row, { onConflict: 'token' }); // token (endpoint or FCM token) is the unique key

    if (error) throw error;
    return NextResponse.json({ success: true, msg: 'Push token registered.' });
  } catch (err: any) {
    console.error('Push subscription register error:', err);
    return NextResponse.json({ success: false, error: 'Could not register subscription.' }, { status: 500 });
  }
}
