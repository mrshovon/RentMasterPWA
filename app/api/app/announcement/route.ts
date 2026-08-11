import { NextResponse } from 'next/server';
import { getAnnouncement, DEFAULT_ANNOUNCEMENT, type Announcement } from '@/lib/app-settings';

// =====================================================================================
// 📢 ANNOUNCEMENT (public read)
// GET -> the announcement the app-open popup shows, or the disabled default.
//
// Public on purpose, exactly like /api/app/maintenance and /api/app/analytics-config:
// middleware.ts only gates /api/admin, /api/super-admin and /api/notifications. Nothing
// sensitive is here — it is a message the admin wrote for everybody. The gate itself decides
// who actually sees the modal (components/announcement-gate.tsx in the UI repo).
//
// While `enabled` is false this returns the empty default rather than the stored draft: a
// hidden announcement is a draft, and a draft must not be readable from the open internet.
//
// Not cached at the edge: when the admin switches the popup off, it must actually stop.
//
// ⚠️ The UI is a DIFFERENT ORIGIN from this backend. A response without CORS headers is
// discarded by the browser and looks identical to "no announcement" — middleware.ts:197-201
// adds them to every /api/app/* route. Check for Access-Control-Allow-Origin before
// debugging anything on the client.
// =====================================================================================

export const dynamic = 'force-dynamic';

const noStore = { status: 200, headers: { 'Cache-Control': 'no-store' } };

export async function GET() {
  try {
    const config = await getAnnouncement();
    const data: Announcement = config.enabled ? config : DEFAULT_ANNOUNCEMENT;
    return NextResponse.json({ success: true, data }, noStore);
  } catch (err: any) {
    console.error('[announcement] read failed:', err);
    // Fail CLOSED (no popup), like analytics-config and unlike the maintenance gate. A hiccup
    // must not put a modal the admin may have already switched off in front of everyone.
    return NextResponse.json({ success: true, data: DEFAULT_ANNOUNCEMENT }, noStore);
  }
}
