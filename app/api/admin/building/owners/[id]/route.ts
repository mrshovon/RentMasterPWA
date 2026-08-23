import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { supabaseAdminEngine } from '@/lib/supabase-server';
import { assertOwnerCanWrite } from '@/lib/subscription';
import { validatePhone } from '@/lib/validate';
import { logPasswordReset, notifyPasswordChanged, clientIpFrom } from '@/lib/password-reset-log';
import { apiError } from '@/lib/api-response';
import {
  requireBuildingAdmin,
  ownerInBuilding,
  forgetBuildingMembership,
  BUILDING_OWNER_SELECT,
} from '@/lib/building';

// =====================================================================================
// 🏢 BUILDING ADMIN — ONE OWNER ON THE ROSTER
// PATCH  -> edit roster details (unit label, default service charge, name/phone), reset the
//           owner's password, or suspend / reactivate their login.
// DELETE -> DETACH them from the building. It does NOT delete the account: that stays a
//           super-admin action, because a building admin must not be able to destroy a person's
//           login and every tenant record under it.
//
// Every handler re-checks that this owner is on THIS admin's roster, so a foreign owner id
// reads as "not found" rather than being editable by whoever guessed it.
// =====================================================================================

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;

    const gate = await requireBuildingAdmin(request);
    if (!gate.ok) return NextResponse.json(gate.body, { status: gate.status });

    const guard = await assertOwnerCanWrite(request.headers.get('x-rentmaster-role'), gate.uid!);
    if (!guard.ok) return NextResponse.json(guard.body, { status: guard.status });

    if (!(await ownerInBuilding(gate.building!.id, id))) {
      return NextResponse.json({ success: false, error: 'That owner is not in your building.' }, { status: 404 });
    }

    const body = await request.json();
    const action = String(body.action || '').trim();

    // --- Reset their password -----------------------------------------------------------
    if (action === 'password') {
      const password = String(body.password || '');
      if (password.length < 8) {
        return NextResponse.json({ success: false, error: 'Password must be at least 8 characters.' }, { status: 400 });
      }
      const { error } = await supabaseAdminEngine.auth.admin.updateUserById(id, { password });
      if (error) throw error;

      let ownerEmail: string | null = null;
      try {
        const { data } = await supabaseAdminEngine.auth.admin.getUserById(id);
        ownerEmail = data?.user?.email || null;
      } catch { /* the log entry is still worth writing without it */ }

      // Same audit trail the super admin writes. A building admin resetting a password is an
      // administrative reset as far as the history is concerned — 'admin_reset' is also the only
      // value the reset_method CHECK constraint would accept for it.
      await logPasswordReset({
        ownerId: id,
        ownerEmail,
        resetBy: gate.uid!,
        method: 'admin_reset',
        ip: clientIpFrom(request.headers),
      });
      void notifyPasswordChanged({ ownerId: id, ownerEmail, byAdmin: true, ip: clientIpFrom(request.headers) });

      return NextResponse.json({ success: true }, { status: 200 });
    }

    // --- Suspend / reactivate their login ------------------------------------------------
    if (action === 'suspend' || action === 'reactivate') {
      const { error } = await supabaseAdminEngine.auth.admin.updateUserById(id, {
        ban_duration: action === 'suspend' ? '876000h' : 'none',
      } as any);
      if (error) throw error;
      return NextResponse.json({ success: true }, { status: 200 });
    }

    // --- Ordinary edit --------------------------------------------------------------------
    // Roster fields live in building_owners; name and phone live on the auth user, so they are
    // written to both places the rest of the app reads them from.
    const rosterFields: Record<string, unknown> = {};
    if (body.unitLabel !== undefined) {
      rosterFields.unit_label = String(body.unitLabel || '').trim().slice(0, 120) || null;
    }
    if (body.defaultServiceCharge !== undefined) {
      const amount = Number(body.defaultServiceCharge);
      if (!Number.isFinite(amount) || amount < 0) {
        return NextResponse.json({ success: false, error: 'The service charge must be a positive amount.' }, { status: 400 });
      }
      rosterFields.default_service_charge = amount;
    }
    if (body.isActive !== undefined) rosterFields.is_active = !!body.isActive;

    if (body.name !== undefined || body.phone !== undefined) {
      const parsedPhone = validatePhone(body.phone);
      if (!parsedPhone.ok) return NextResponse.json({ success: false, error: parsedPhone.error }, { status: 400 });

      const { data: current } = await supabaseAdminEngine.auth.admin.getUserById(id);
      const meta = (current?.user?.user_metadata as any) || {};
      const name = body.name !== undefined ? String(body.name || '').trim() : meta.name;
      const phone = body.phone !== undefined ? parsedPhone.value : meta.phone;

      // Spread the existing metadata: updateUserById replaces the whole object, so naming only
      // the changed keys would wipe the role and everything else stored there.
      const { error: metaErr } = await supabaseAdminEngine.auth.admin.updateUserById(id, {
        user_metadata: { ...meta, name, phone },
      });
      if (metaErr) throw metaErr;

      await supabaseAdminEngine.from('user_profiles').upsert(
        { id, name: name || 'Owner', phone, role: 'owner' },
        { onConflict: 'id' }
      );
    }

    if (Object.keys(rosterFields).length) {
      rosterFields.updated_at = new Date().toISOString();
      const { error } = await supabaseAdminEngine
        .from('building_owners')
        .update(rosterFields)
        .eq('building_id', gate.building!.id)
        .eq('owner_id', id);
      if (error) throw error;
      forgetBuildingMembership(id);
    }

    const { data: row, error: readErr } = await supabaseAdminEngine
      .from('building_owners')
      .select(BUILDING_OWNER_SELECT)
      .eq('owner_id', id)
      .maybeSingle();
    if (readErr) throw readErr;

    return NextResponse.json({ success: true, data: row }, { status: 200 });
  } catch (err) {
    return apiError(request, err);
  }
}

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;

    const gate = await requireBuildingAdmin(request);
    if (!gate.ok) return NextResponse.json(gate.body, { status: gate.status });

    const guard = await assertOwnerCanWrite(request.headers.get('x-rentmaster-role'), gate.uid!);
    if (!guard.ok) return NextResponse.json(guard.body, { status: guard.status });

    if (!(await ownerInBuilding(gate.building!.id, id))) {
      return NextResponse.json({ success: false, error: 'That owner is not in your building.' }, { status: 404 });
    }

    const { error } = await supabaseAdminEngine
      .from('building_owners')
      .delete()
      .eq('building_id', gate.building!.id)
      .eq('owner_id', id);
    if (error) throw error;

    forgetBuildingMembership(id);

    // Said plainly in the response because the consequence is not obvious: the login survives,
    // but from the next request onward it resolves to the Free plan and its own limits.
    return NextResponse.json(
      {
        success: true,
        message: 'Detached from the building. The login still works, but it now falls back to the free plan limits.',
      },
      { status: 200 }
    );
  } catch (err) {
    return apiError(request, err);
  }
}
