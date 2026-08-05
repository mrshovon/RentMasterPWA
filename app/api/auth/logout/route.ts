import { NextResponse } from 'next/server';
import { supabaseAdminEngine } from '@/lib/supabase-server';

// =====================================================================================
// 🔐 LOGOUT — revoke an owner/admin session server-side (public route).
// POST { accessToken } -> Supabase revokes the refresh token behind that session.
//
// Signing out used to be purely local: the frontend dropped its localStorage keys and
// navigated away, but the refresh token stayed valid on Supabase for its full lifetime. Anyone
// who had copied it out beforehand could keep minting access tokens from an account the user
// believed they had signed out of. This closes that.
//
// Always answers 200. The client fires this un-awaited, immediately before navigating to the
// login screen, and has already discarded the session locally — there is no failure it could
// usefully act on, and reporting one would only mean showing an error to someone who has
// successfully signed out.
//
// TENANTS ARE NOT COVERED. Their token is a backend-signed HMAC JWT (lib/tenant-jwt.ts) with a
// 7-day TTL and no server-side record, so there is nothing to revoke; it stays valid until it
// expires regardless. Closing that needs a token version or denylist column on `tenants`.
// =====================================================================================

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export async function OPTIONS() {
  return NextResponse.json({}, { headers: cors });
}

export async function POST(request: Request) {
  try {
    const { accessToken } = await request.json();

    if (accessToken && typeof accessToken === 'string') {
      // 'global' ends every session for this user across their devices, which is not what a
      // sign-out on one device should do. The default scope revokes just this session.
      await supabaseAdminEngine.auth.admin.signOut(accessToken);
    }
  } catch (err: any) {
    // An already-expired or tenant token lands here. Nothing to do: the session the caller
    // wanted gone is gone either way.
    console.warn('Logout revocation skipped:', err?.message || err);
  }

  return NextResponse.json({ success: true }, { status: 200, headers: cors });
}
