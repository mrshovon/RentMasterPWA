import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { touchPresence, PresenceRole } from '@/lib/presence';

// =====================================================================================
// 💓 PRESENCE HEARTBEAT
// POST { deviceId, platform } -> record that this session is alive right now.
//
// Deliberately lives under /api/admin/ so middleware.ts already resolves and injects a
// VERIFIED identity (x-rentmaster-uid for owner/admin, x-rentmaster-tenant-id for tenants)
// with any client-supplied identity headers stripped. Putting it anywhere else would mean
// writing a second auth gate, or trusting a user id from the request body.
//
// NOT wrapped in assertOwnerCanWrite: an owner whose plan has lapsed is locked out of
// writes, but they are still using the app and must still show as online.
// =====================================================================================

export async function POST(request: NextRequest) {
  try {
    const ownerId = request.headers.get('x-rentmaster-uid');
    const tenantId = request.headers.get('x-rentmaster-tenant-id');
    const headerRole = request.headers.get('x-rentmaster-role');

    const userId = tenantId || ownerId;
    if (!userId) {
      return NextResponse.json({ success: false, error: 'Unauthorized.' }, { status: 401 });
    }

    // Trust the middleware-resolved role, never the body.
    const role: PresenceRole = tenantId ? 'tenant' : headerRole === 'admin' ? 'admin' : 'owner';

    const body = await request.json().catch(() => ({}));
    const deviceId = String(body.deviceId || '').trim().slice(0, 100);
    if (!deviceId) {
      return NextResponse.json({ success: false, error: 'deviceId is required.' }, { status: 400 });
    }
    const platform = body.platform === 'android' || body.platform === 'web' ? body.platform : null;

    const result = await touchPresence({
      userId,
      deviceId,
      role,
      platform,
      userAgent: request.headers.get('user-agent'),
    });

    // A heartbeat is best-effort telemetry. It must never surface an error to a user who is
    // just using the app, so a failed write still answers 200 and reports itself in the body.
    return NextResponse.json({ success: result.ok, reason: result.error }, {
      status: 200,
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch (err: any) {
    console.error('[presence] heartbeat error:', err);
    return NextResponse.json({ success: false, error: err.message }, { status: 200 });
  }
}
