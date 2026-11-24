import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import crypto from 'crypto';
import { supabaseAdminEngine } from '@/lib/supabase-server';
import { assertOwnerCanWrite } from '@/lib/subscription';
import { requireBuildingAdmin, ownerInBuilding } from '@/lib/building';
import { logPasswordReset, notifyPasswordChanged, clientIpFrom } from '@/lib/password-reset-log';
import { apiError } from '@/lib/api-response';

// =====================================================================================
// BUILDING ADMIN — ISSUE FRESH CREDENTIALS FOR A FLAT OWNER TO SHARE
//
// POST -> generates a strong password, installs it on the auth user, and returns the login ID
//         (auth.users.email) beside it ONCE so the admin can send both over WhatsApp.
//
// The login ID itself is NEVER regenerated: it is the identifier issued at creation and the source
// of truth for the @bari360.com address. Only the password changes, exactly as the existing
// `action: 'password'` PATCH does — this route exists so the admin does not have to invent a weak
// password by hand and then copy two values out of a modal.
//
// requireBuildingAdmin + ownerInBuilding keep one building out of another's roster.
// =====================================================================================

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const gate = await requireBuildingAdmin(request);
    if (!gate.ok) return NextResponse.json(gate.body, { status: gate.status });

    const guard = await assertOwnerCanWrite(request.headers.get('x-rentmaster-role'), gate.uid!);
    if (!guard.ok) return NextResponse.json(guard.body, { status: guard.status });

    const { id } = await params;
    if (!(await ownerInBuilding(gate.building!.id, id))) {
      return NextResponse.json({ success: false, error: 'That owner is not in your building.' }, { status: 404 });
    }

    const { data: authUser, error: getErr } = await supabaseAdminEngine.auth.admin.getUserById(id);
    if (getErr || !authUser?.user) {
      return NextResponse.json({ success: false, error: 'Owner account not found.' }, { status: 404 });
    }
    const loginId = authUser.user.email || null;
    if (!loginId) {
      return NextResponse.json({ success: false, error: 'This account has no login identifier.' }, { status: 409 });
    }

    // 24 URL-safe characters from 18 bytes — more than enough entropy, no dictionary words.
    const freshPassword = crypto.randomBytes(18).toString('base64url');
    const { error: updErr } = await supabaseAdminEngine.auth.admin.updateUserById(id, { password: freshPassword });
    if (updErr) throw updErr;

    const meta = (authUser.user.user_metadata as any) || {};
    const ip = clientIpFrom(request.headers);
    await logPasswordReset({ ownerId: id, ownerEmail: loginId, resetBy: gate.uid!, method: 'admin_reset', ip });
    void notifyPasswordChanged({ ownerId: id, ownerEmail: loginId, byAdmin: true, ip });

    return NextResponse.json({
      success: true,
      message: 'Fresh credentials generated. Share them once and do not store them.',
      data: { loginId, password: freshPassword, name: meta.name || null, phone: meta.phone || null },
    }, { status: 200 });
  } catch (err) {
    return apiError(request, err);
  }
}
