import { NextResponse } from 'next/server';
import { supabaseAdminEngine } from '@/lib/supabase-server';

// Registers a Web Push (VAPID) subscription for the authenticated user. Identity is
// injected + verified by middleware (client-supplied identity headers are stripped there).
export async function POST(request: Request) {
  try {
    const userId = request.headers.get('x-rentmaster-uid') || request.headers.get('x-rentmaster-tenant-id');
    const role = request.headers.get('x-rentmaster-role') || null;
    if (!userId) {
      return NextResponse.json({ success: false, error: 'Unauthorized.' }, { status: 401 });
    }

    const body = await request.json();
    const sub = body?.subscription;
    // Expect a standard PushSubscription: { endpoint, keys: { p256dh, auth } }.
    if (!sub?.endpoint || !sub?.keys?.p256dh || !sub?.keys?.auth) {
      return NextResponse.json({ success: false, error: 'A valid push subscription is required.' }, { status: 400 });
    }

    const { error } = await supabaseAdminEngine
      .from('device_tokens')
      .upsert({
        user_id: userId,
        token: sub.endpoint,        // endpoint is the unique subscription key
        p256dh: sub.keys.p256dh,
        auth: sub.keys.auth,
        role,
        device_type: body.deviceDetails || 'web',
      }, { onConflict: 'token' });

    if (error) throw error;
    return NextResponse.json({ success: true, msg: 'Push subscription registered.' });
  } catch (err: any) {
    console.error('Push subscription register error:', err);
    return NextResponse.json({ success: false, error: 'Could not register subscription.' }, { status: 500 });
  }
}
