import { NextResponse } from 'next/server';
import { getTermsVersion, DEFAULT_TERMS_VERSION } from '@/lib/app-settings';

// =====================================================================================
// 📄 CURRENT LEGAL DOCUMENT VERSION (public read)
// GET -> { version } — which edition of the Terms and Privacy Policy is published today.
//
// Public on purpose, and it has to be: the signup form reads this BEFORE any account exists,
// so there is no session to authenticate with. `middleware.ts` only gates /api/admin,
// /api/super-admin and /api/notifications, so this falls through to the public branch.
// The payload is a date string that is also printed at the top of the documents themselves —
// there is nothing here to protect.
//
// The signup form echoes this value back on submit, so terms_acceptances.version records the
// edition the person was actually shown rather than whatever the server considers current a
// moment later.
//
// Deliberately NOT cached: publishing an updated version has to take effect on the next signup,
// and a stale cache would record consent against text nobody saw.
// =====================================================================================

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const version = await getTermsVersion();
    return NextResponse.json(
      { success: true, data: { version } },
      { status: 200, headers: { 'Cache-Control': 'no-store' } }
    );
  } catch (err: any) {
    console.error('[terms-version] read failed:', err);
    // Fall back to the compiled-in default rather than failing: signup must not become
    // impossible because the settings table hiccuped. The default is the first published
    // edition, so a recorded acceptance still names a real document.
    return NextResponse.json(
      { success: true, data: { version: DEFAULT_TERMS_VERSION } },
      { status: 200, headers: { 'Cache-Control': 'no-store' } }
    );
  }
}
