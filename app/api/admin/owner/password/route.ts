import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { supabaseAdminEngine } from '@/lib/supabase-server';
import { logPasswordReset, clientIpFrom } from '@/lib/password-reset-log';

// =====================================================================================
// 🔐 OWNER CHANGE PASSWORD — in-app, while logged in (owner self-service)
// POST { currentPassword, newPassword } -> re-verify the current password, then update.
// Lives under /api/admin/ so middleware authenticates the caller and injects x-rentmaster-uid.
// Writes a self_change row to the audit log.
// =====================================================================================

const MIN_PASSWORD_LEN = 8;

export async function POST(request: NextRequest) {
  try {
    const ownerId = request.headers.get('x-rentmaster-uid');
    const tenantHeaderId = request.headers.get('x-rentmaster-tenant-id');

    if (tenantHeaderId) {
      return NextResponse.json({ error: 'Tenants cannot change an owner password.' }, { status: 403 });
    }
    if (!ownerId) {
      return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 });
    }

    const { currentPassword, newPassword } = await request.json();
    if (!currentPassword || !newPassword) {
      return NextResponse.json({ error: 'Current and new passwords are required.' }, { status: 400 });
    }
    if (String(newPassword).length < MIN_PASSWORD_LEN) {
      return NextResponse.json({ error: `New password must be at least ${MIN_PASSWORD_LEN} characters.` }, { status: 400 });
    }
    if (currentPassword === newPassword) {
      return NextResponse.json({ error: 'The new password must be different from the current one.' }, { status: 400 });
    }

    // Look up the owner's email (owners are auth users; email isn't in the identity headers).
    const { data: cur, error: getErr } = await supabaseAdminEngine.auth.admin.getUserById(ownerId);
    if (getErr || !cur?.user?.email) {
      return NextResponse.json({ error: 'Account not found.' }, { status: 404 });
    }
    const email = cur.user.email;

    // Re-authenticate with the CURRENT password on a throwaway client so we never disturb any
    // shared client session. Wrong current password -> reject (this is the security gate).
    const verifier = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      { auth: { autoRefreshToken: false, persistSession: false } },
    );
    const { data: signIn, error: signInErr } = await verifier.auth.signInWithPassword({
      email,
      password: currentPassword,
    });
    if (signInErr || !signIn?.user) {
      return NextResponse.json({ error: 'Current password is incorrect.' }, { status: 401 });
    }

    // Apply the new password with the service role.
    const { error: updErr } = await supabaseAdminEngine.auth.admin.updateUserById(ownerId, { password: newPassword });
    if (updErr) {
      return NextResponse.json({ error: updErr.message }, { status: 500 });
    }

    await logPasswordReset({
      ownerId,
      ownerEmail: email,
      resetBy: ownerId, // the owner acted on their own account
      method: 'self_change',
      ip: clientIpFrom(request.headers),
    });

    return NextResponse.json({ success: true, message: 'Password updated.' }, { status: 200 });
  } catch (err: any) {
    console.error('Owner change-password crash:', err);
    return NextResponse.json({ error: err.message || 'Fatal Server Logic Exception.' }, { status: 500 });
  }
}
