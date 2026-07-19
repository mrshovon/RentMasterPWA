import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { supabaseClient } from '@/lib/supabase-server';
import { logPasswordReset, clientIpFrom } from '@/lib/password-reset-log';

// =====================================================================================
// 🔐 FORGOT PASSWORD — owner self-service, step 2: audit log (public route)
// POST { accessToken } -> the frontend reset page calls this AFTER it has changed the
//   password via the Supabase recovery session. We verify the token server-side to trust
//   the owner id/email (the token can't be forged), then write the self_service_email row.
//   The password change already happened on Supabase; this only records it.
// =====================================================================================

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export async function OPTIONS() {
  return NextResponse.json({}, { headers: cors });
}

export async function POST(request: NextRequest) {
  try {
    const { accessToken } = await request.json();
    if (!accessToken || typeof accessToken !== 'string') {
      return NextResponse.json({ success: false, error: 'accessToken is required.' }, { status: 400, headers: cors });
    }

    // Verify the recovery session token — this is what makes the logged owner id trustworthy.
    const { data, error } = await supabaseClient.auth.getUser(accessToken);
    if (error || !data?.user) {
      return NextResponse.json({ success: false, error: 'Invalid or expired session.' }, { status: 401, headers: cors });
    }

    await logPasswordReset({
      ownerId: data.user.id,
      ownerEmail: data.user.email || null,
      resetBy: null, // self-service — the owner acted, not an admin
      method: 'self_service_email',
      ip: clientIpFrom(request.headers),
    });

    return NextResponse.json({ success: true }, { status: 200, headers: cors });
  } catch (err: any) {
    console.error('Reset-complete error:', err);
    return NextResponse.json({ success: false, error: 'Could not record the reset.' }, { status: 500, headers: cors });
  }
}
