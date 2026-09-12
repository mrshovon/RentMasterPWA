import { NextResponse } from 'next/server';
import { getLoginPopups, activePopups, DEFAULT_POPUP_SET } from '@/lib/app-settings';

// =====================================================================================
// 👋 LOGIN BANNERS (public read)
// GET -> the active banners the signed-out login screen shows on a phone, in order.
//
// Public by necessity, not just by convention: its entire audience is people who have no account
// yet. middleware.ts only gates /api/admin, /api/super-admin and /api/notifications.
//
// ⭐ INACTIVE ITEMS ARE STRIPPED ENTIRELY. An inactive banner is a draft the admin is still
// writing, and this endpoint is reachable by anyone on the internet — including, by design, people
// with no account at all. Serving a draft here is the one leak this feature can have.
//
// Not cached at the edge: when the admin switches a banner off, it must actually stop.
//
// ⚠️ The UI is a DIFFERENT ORIGIN from this backend. A response without CORS headers is discarded
// by the browser and looks identical to "no banners" — middleware.ts adds them to every
// /api/app/* route. Check for Access-Control-Allow-Origin before debugging the client.
// =====================================================================================

export const dynamic = 'force-dynamic';

const noStore = { status: 200, headers: { 'Cache-Control': 'no-store' } };

export async function GET() {
  try {
    const data = activePopups(await getLoginPopups());
    return NextResponse.json({ success: true, data }, noStore);
  } catch (err: any) {
    console.error('[login-popup] read failed:', err);
    // Fail CLOSED (no popup). A hiccup must not put a modal the admin may have already switched
    // off in front of every visitor to the sign-in screen.
    return NextResponse.json({ success: true, data: DEFAULT_POPUP_SET }, noStore);
  }
}
