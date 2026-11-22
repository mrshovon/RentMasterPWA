import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { supabaseAdminEngine } from '@/lib/supabase-server';
import { apiError } from '@/lib/api-response';
import { changeOwnerEmail } from '@/lib/email-change';
import { selfEmailChangeEnabled, setSelfEmailChange } from '@/lib/email-change-flag';
import { resolveAppBaseUrl } from '@/lib/public-url';
import { logEvent, describeError } from '@/lib/logger';

// =====================================================================================
// 🔐 OWNER CHANGE EMAIL — opt-in, in-app, while logged in
//
// POST { newEmail, currentPassword }
//
// The opt-in lives in owner_addons, not user_metadata (which the account holder can write
// themselves with the shipped anon key). It is ONE-SHOT: a successful change switches it back
// off here, so the admin must opt this person in again before they can change it a second time.
//
// The current password is the verification: it is checked on a throwaway anon client so no
// shared session is disturbed, exactly as in the sibling owner/password route.
//
// Lives under /api/admin/ so middleware authenticates the caller and injects x-rentmaster-uid.
// assertOwnerCanWrite is deliberately NOT applied — a lapsed plan must not block fixing a login
// address, any more than it blocks fixing a typo in your own name.
// =====================================================================================

export async function POST(request: NextRequest) {
  try {
    const ownerId = request.headers.get('x-rentmaster-uid');
    if (request.headers.get('x-rentmaster-tenant-id')) {
      return NextResponse.json({ error: 'Tenants cannot change an owner email.' }, { status: 403 });
    }
    if (!ownerId) return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 });

    // The gate first: an opted-out owner learns nothing about the rest of the flow.
    if (!(await selfEmailChangeEnabled(ownerId))) {
      return NextResponse.json({
        success: false,
        code: 'SELF_EMAIL_CHANGE_DISABLED',
        error: 'Your administrator has not enabled email changes for your account. Contact support.',
      }, { status: 403 });
    }

    const { newEmail, currentPassword } = await request.json();
    if (!newEmail || !currentPassword) {
      return NextResponse.json({ error: 'New email and current password are required.' }, { status: 400 });
    }

    const { data: cur, error: getErr } = await supabaseAdminEngine.auth.admin.getUserById(ownerId);
    if (getErr || !cur?.user?.email) {
      return NextResponse.json({ error: 'Account not found.' }, { status: 404 });
    }
    const currentEmail = cur.user.email;

    // Re-authenticate with the CURRENT password on a throwaway client. Wrong password is the
    // security gate; never touch a shared session to do it.
    const verifier = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      { auth: { autoRefreshToken: false, persistSession: false } },
    );
    const { data: signIn, error: signInErr } = await verifier.auth.signInWithPassword({
      email: currentEmail,
      password: String(currentPassword),
    });
    if (signInErr || !signIn?.user) {
      return NextResponse.json({ error: 'Current password is incorrect.' }, { status: 401 });
    }

    const result = await changeOwnerEmail({
      request,
      ownerId,
      newEmail: String(newEmail),
      actor: 'self',
      oldEmail: currentEmail,
      appUrl: resolveAppBaseUrl(request),
    });
    if (!result.ok) {
      return NextResponse.json({ success: false, error: result.error, code: result.code }, { status: result.status });
    }

    // One-shot. The email has already changed, so a failure to clear the flag must not turn this
    // into an error response — log it loudly and keep the successful result.
    try {
      await setSelfEmailChange(ownerId, false, ownerId);
    } catch (err) {
      await logEvent({
        level: 'warn',
        source: 'api',
        message: `Could not clear one-shot self-email-change flag for ${ownerId}`,
        detail: describeError(err).detail,
        context: { ownerId },
      });
    }

    return NextResponse.json({
      success: true,
      message: 'Sign-in email changed. Use the new address next time you sign in.',
      data: { email: result.email, emailChangeAllowed: false },
    }, { status: 200 });
  } catch (err) {
    return apiError(request, err);
  }
}
