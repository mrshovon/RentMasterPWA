import { NextResponse } from 'next/server';
import { getAnalyticsConfig, DEFAULT_ANALYTICS_CONFIG } from '@/lib/app-settings';

// =====================================================================================
// 📈 ANALYTICS CONFIG (public read)
// GET -> { gaMeasurementId, gtmContainerId, enabledWeb, enabledApp } for the client tag loader.
//
// Public on purpose, exactly like /api/app/maintenance: middleware.ts only gates /api/admin,
// /api/super-admin and /api/notifications, and this has to answer on the login screen before
// any session exists. A GA measurement ID is not a secret — it ships in the page source of
// every site that uses one.
//
// Not cached at the edge: when the admin turns tracking off, it must actually stop.
// =====================================================================================

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const config = await getAnalyticsConfig();
    return NextResponse.json({ success: true, data: config }, {
      status: 200, headers: { 'Cache-Control': 'no-store' },
    });
  } catch (err: any) {
    console.error('[analytics-config] read failed:', err);
    // Fail CLOSED (analytics off). The opposite of the maintenance gate, which fails open:
    // there, a hiccup must not lock users out; here, a hiccup must not load a tracker the
    // admin may have deliberately disabled.
    return NextResponse.json({ success: true, data: DEFAULT_ANALYTICS_CONFIG }, {
      status: 200, headers: { 'Cache-Control': 'no-store' },
    });
  }
}
