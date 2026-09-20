import { NextResponse } from 'next/server';
import { getFontConfig, DEFAULT_FONT_CONFIG } from '@/lib/app-settings';

// =====================================================================================
// 🔤 FONT CONFIG (public read)
// GET -> the FontConfig every client uses to build its font stacks.
//
// Public on purpose, exactly like /api/app/analytics-config and /api/app/maintenance:
// middleware.ts only gates /api/admin, /api/super-admin and /api/notifications, and the
// sign-in screen has to render in the right typeface before any session exists. A font name
// is not a secret — it is visible in the rendered page to anyone who opens DevTools.
//
// Not cached at the edge: when the admin changes the font it has to actually change.
// =====================================================================================

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const config = await getFontConfig();
    return NextResponse.json({ success: true, data: config }, {
      status: 200, headers: { 'Cache-Control': 'no-store' },
    });
  } catch (err: any) {
    console.error('[font-config] read failed:', err);
    // Fail CLOSED, i.e. to the DEFAULT config — which is not "no font", it is the built-in
    // system stack the app shipped with. A hiccup here makes the app look like it did last
    // month; it can never leave it with a broken font-family.
    return NextResponse.json({ success: true, data: DEFAULT_FONT_CONFIG }, {
      status: 200, headers: { 'Cache-Control': 'no-store' },
    });
  }
}
