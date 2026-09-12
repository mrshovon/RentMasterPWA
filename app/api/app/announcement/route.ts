import { NextResponse } from 'next/server';
import { getAnnouncements, activePopups, DEFAULT_POPUP_SET } from '@/lib/app-settings';

// =====================================================================================
// 📢 ANNOUNCEMENTS (public read)
// GET -> the active announcements the app-open popup shows, in order.
//
// Public on purpose, exactly like /api/app/maintenance and /api/app/analytics-config:
// middleware.ts only gates /api/admin, /api/super-admin and /api/notifications. Nothing
// sensitive is here — these are messages the admin wrote for everybody. The gate itself decides
// who actually sees the modal (components/announcement-gate.tsx in the UI repo).
//
// ⭐ INACTIVE ITEMS ARE STRIPPED ENTIRELY, not just flagged. An inactive announcement is a DRAFT
// the admin is still writing, and a draft must not be readable from the open internet merely
// because the endpoint that serves its published siblings has to be.
//
// Not cached at the edge: when the admin switches a popup off, it must actually stop.
//
// ⚠️ The UI is a DIFFERENT ORIGIN from this backend. A response without CORS headers is
// discarded by the browser and looks identical to "no announcements" — middleware.ts adds them
// to every /api/app/* route. Check for Access-Control-Allow-Origin before debugging the client.
// =====================================================================================

export const dynamic = 'force-dynamic';

const noStore = { status: 200, headers: { 'Cache-Control': 'no-store' } };

export async function GET() {
  try {
    const data = activePopups(await getAnnouncements());
    return NextResponse.json({ success: true, data }, noStore);
  } catch (err: any) {
    console.error('[announcement] read failed:', err);
    // Fail CLOSED (no popup), like analytics-config and unlike the maintenance gate. A hiccup
    // must not put a modal the admin may have already switched off in front of everyone.
    return NextResponse.json({ success: true, data: DEFAULT_POPUP_SET }, noStore);
  }
}
