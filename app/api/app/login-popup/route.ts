import { NextResponse } from 'next/server';
import { getLoginPopup, DEFAULT_LOGIN_POPUP, type LoginPopup } from '@/lib/app-settings';

// =====================================================================================
// 👋 LOGIN POPUP (public read)
// GET -> the popup the signed-out login screen shows on a phone, or the disabled default.
//
// Public by necessity, not just by convention: its entire audience is people who have no account
// yet. middleware.ts only gates /api/admin, /api/super-admin and /api/notifications.
//
// While `enabled` is false this returns the empty default rather than the stored draft. A hidden
// popup is a DRAFT — the admin is still writing it — and a draft must not be readable from the
// open internet just because the endpoint that serves it has to be.
//
// Not cached at the edge: when the admin switches the popup off, it must actually stop.
//
// ⚠️ The UI is a DIFFERENT ORIGIN from this backend. A response without CORS headers is discarded
// by the browser and looks identical to "no popup" — middleware.ts adds them to every /api/app/*
// route. Check for Access-Control-Allow-Origin before debugging anything on the client.
// =====================================================================================

export const dynamic = 'force-dynamic';

const noStore = { status: 200, headers: { 'Cache-Control': 'no-store' } };

export async function GET() {
  try {
    const config = await getLoginPopup();
    const data: LoginPopup = config.enabled ? config : DEFAULT_LOGIN_POPUP;
    return NextResponse.json({ success: true, data }, noStore);
  } catch (err: any) {
    console.error('[login-popup] read failed:', err);
    // Fail CLOSED (no popup), like /api/app/announcement. A hiccup must not put a modal the admin
    // may have already switched off in front of every visitor to the sign-in screen.
    return NextResponse.json({ success: true, data: DEFAULT_LOGIN_POPUP }, noStore);
  }
}
