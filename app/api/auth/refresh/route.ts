import { NextResponse } from 'next/server';
import { supabaseClient } from '@/lib/supabase-server';

// =====================================================================================
// 🔁 TOKEN REFRESH — owner/admin only (public route, not behind middleware auth).
// POST { refreshToken } -> exchanges the Supabase refresh token for a fresh access token,
// so a logged-in owner/admin stays signed in until they explicitly log out.
//
// Supabase ROTATES the refresh token on each use, so the new one is returned and the client
// must store it. A failed refresh (expired/revoked/reused) returns 401 so the client logs out.
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
    const { refreshToken } = await request.json();
    if (!refreshToken || typeof refreshToken !== 'string') {
      return NextResponse.json({ success: false, error: 'A refresh token is required.' }, { status: 400, headers: cors });
    }

    const { data, error } = await supabaseClient.auth.refreshSession({ refresh_token: refreshToken });
    if (error || !data.session) {
      return NextResponse.json(
        { success: false, code: 'REFRESH_FAILED', error: 'Session expired. Please log in again.' },
        { status: 401, headers: cors },
      );
    }

    const u = data.user;
    const role = (u?.user_metadata as any)?.role || 'owner';
    return NextResponse.json({
      success: true,
      token: data.session.access_token,
      refreshToken: data.session.refresh_token,
      expiresAt: data.session.expires_at,
      role,
      id: u?.id,
      name: (u?.user_metadata as any)?.name || u?.email || 'Owner',
    }, { status: 200, headers: cors });
  } catch (err: any) {
    console.error('Token refresh error:', err);
    return NextResponse.json({ success: false, code: 'REFRESH_FAILED', error: 'Could not refresh session.' }, { status: 401, headers: cors });
  }
}
