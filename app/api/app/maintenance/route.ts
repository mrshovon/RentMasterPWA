import { NextResponse } from 'next/server';
import { getMaintenanceMode, DEFAULT_MAINTENANCE_MODE } from '@/lib/app-settings';

// =====================================================================================
// 🛠 MAINTENANCE MODE (public read)
// GET -> { enabled, startAt, endAt, message } for the client-side maintenance gate.
//
// Public on purpose: `middleware.ts` only gates /api/admin, /api/super-admin and
// /api/notifications. The gate has to answer on the login screen too — before any session
// token exists — and the payload is an announcement, not a secret.
//
// Deliberately NOT cached at the edge: when the admin switches maintenance OFF, users must
// get back in immediately, and a stale cache would strand them.
// =====================================================================================

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const mode = await getMaintenanceMode();
    return NextResponse.json(
      { success: true, data: mode },
      { status: 200, headers: { 'Cache-Control': 'no-store' } }
    );
  } catch (err: any) {
    console.error('[maintenance] read failed:', err);
    // Fail OPEN: a settings-table hiccup must never lock every user out of the app.
    return NextResponse.json(
      { success: true, data: DEFAULT_MAINTENANCE_MODE },
      { status: 200, headers: { 'Cache-Control': 'no-store' } }
    );
  }
}
