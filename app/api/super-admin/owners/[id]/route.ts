import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { supabaseAdminEngine } from '@/lib/supabase-server';
import { logPasswordReset, notifyPasswordChanged, clientIpFrom } from '@/lib/password-reset-log';
import { getPresenceFor } from '@/lib/presence';
import { apiError } from '@/lib/api-response';
import { ownedBuilding, buildingMembershipOf, countActiveBuildingOwners, buildingOwnerIds, forgetBuildingMembership } from '@/lib/building';
import { purgeOwnerAccount } from '@/lib/account-purge';

// =====================================================================================
// 🛡️ ADMIN — SINGLE OWNER
// GET    -> full details (auth + profile + subscription + property/tenant counts)
// PATCH  -> edit details / reset password / suspend|reactivate / revoke|grant permission
//           / cancel subscription
// DELETE -> remove the account
// =====================================================================================
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const { data: authRes, error } = await supabaseAdminEngine.auth.admin.getUserById(id);
    if (error || !authRes?.user) {
      return NextResponse.json({ success: false, error: error?.message || 'Owner not found.' }, { status: 404 });
    }
    const u = authRes.user;
    const meta = (u.user_metadata as any) || {};

    const { data: profile } = await supabaseAdminEngine.from('user_profiles').select('*').eq('id', id).maybeSingle();
    const { data: subscription } = await supabaseAdminEngine
      .from('subscription_history')
      .select('*, subscription_tiers:tier_id ( name, price, currency, max_properties_allowed, max_tenants_allowed )')
      .eq('owner_id', id)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    // Staff add-on state: bundled with the plan, or granted per-owner (see lib/features.ts).
    // When the plan already includes it, the per-owner grant is moot and the UI disables it.
    // Both are separate, error-tolerant queries rather than a join on the subscription select:
    // before ADD_STAFF.sql runs, the table/column don't exist, and a failed join would take the
    // whole owner-detail page down instead of just reporting the add-on as off.
    const { data: staffAddonRow } = await supabaseAdminEngine
      .from('owner_addons')
      .select('enabled, granted_at')
      .eq('owner_id', id)
      .eq('addon_key', 'staff')
      .maybeSingle();

    // Accounts add-on: same shape as staff (see lib/features.ts). Separate error-tolerant queries.
    const { data: accountsAddonRow } = await supabaseAdminEngine
      .from('owner_addons')
      .select('enabled, granted_at')
      .eq('owner_id', id)
      .eq('addon_key', 'accounts')
      .maybeSingle();

    let staffIncludedInPlan = false;
    let accountsIncludedInPlan = false;
    const planTierId = (subscription as any)?.tier_id;
    if (planTierId) {
      const { data: tierRow } = await supabaseAdminEngine
        .from('subscription_tiers')
        .select('staff_included, accounts_included')
        .eq('id', planTierId)
        .maybeSingle();
      staffIncludedInPlan = !!tierRow?.staff_included;
      accountsIncludedInPlan = !!tierRow?.accounts_included;
    }

    const { data: props } = await supabaseAdminEngine.from('properties').select('id').eq('owner_id', id);
    const propertyIds = (props || []).map((p) => p.id);
    let tenantCount = 0;
    if (propertyIds.length) {
      const { count } = await supabaseAdminEngine
        .from('tenants').select('id', { count: 'exact', head: true }).in('property_id', propertyIds);
      tenantCount = count || 0;
    }

    const banned = !!(u as any).banned_until && new Date((u as any).banned_until).getTime() > Date.now();

    // Per-device presence for this account (empty until ADD_PRESENCE.sql is run).
    const presence = (await getPresenceFor([id]))[id];

    // Whole Building context: the building they run, or the one they are a flat owner in.
    // Both helpers return null on any error, so this is inert before ADD_BUILDINGS.sql is run.
    const runsBuilding = await ownedBuilding(id);
    const memberOf = runsBuilding ? null : await buildingMembershipOf(id);
    const memberCount = runsBuilding ? await countActiveBuildingOwners(runsBuilding.id) : 0;

    return NextResponse.json({
      success: true,
      data: {
        id: u.id,
        email: u.email || null,
        name: meta.name || null,
        phone: meta.phone || u.phone || null,
        role: meta.role || 'owner',
        created_at: u.created_at,
        last_sign_in_at: u.last_sign_in_at || null,
        online: !!presence?.online,
        last_seen_at: presence?.lastSeenAt || null,
        devices: presence?.devices || [],
        suspended: banned,
        permissions_revoked: !!meta.permissions_revoked,
        profile: profile || null,
        subscription: subscription || null,
        staff_addon: !!staffAddonRow?.enabled,
        staff_addon_granted_at: staffAddonRow?.granted_at || null,
        staff_included_in_plan: staffIncludedInPlan,
        accounts_addon: !!accountsAddonRow?.enabled,
        accounts_addon_granted_at: accountsAddonRow?.granted_at || null,
        accounts_included_in_plan: accountsIncludedInPlan,
        propertyCount: propertyIds.length,
        tenantCount,
        building: runsBuilding
          ? { id: runsBuilding.id, name: runsBuilding.name, role: 'admin', ownerCount: memberCount }
          : memberOf
            ? { id: memberOf.buildingId, name: memberOf.buildingName, role: 'member', ownerCount: 0 }
            : null,
      },
    }, { status: 200 });
  } catch (err) {
    return apiError(request, err);
  }
}

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const body = await request.json();
    const { action, name, phone, password } = body;

    const { data: cur } = await supabaseAdminEngine.auth.admin.getUserById(id);
    const meta = ((cur?.user?.user_metadata as any) || {});

    // --- Account actions ---
    if (action === 'suspend' || action === 'reactivate') {
      const { error } = await supabaseAdminEngine.auth.admin.updateUserById(id, {
        ban_duration: action === 'suspend' ? '876000h' : 'none', // ~100 years / lifted
      });
      if (error) throw error;
      return NextResponse.json({ success: true, message: action === 'suspend' ? 'Account access suspended.' : 'Account access restored.' });
    }

    if (action === 'revoke_permission' || action === 'grant_permission') {
      const { error } = await supabaseAdminEngine.auth.admin.updateUserById(id, {
        user_metadata: { ...meta, permissions_revoked: action === 'revoke_permission' },
      });
      if (error) throw error;
      return NextResponse.json({ success: true, message: action === 'revoke_permission' ? 'Management permissions revoked.' : 'Management permissions restored.' });
    }

    // Paid add-on grants. Kept in owner_addons rather than user_metadata, which the owner
    // can write themselves — see ADD_STAFF.sql / lib/features.ts. One generic handler per key.
    const ADDON_LABELS: Record<string, string> = { staff: 'Staff', accounts: 'Accounts' };
    const addonMatch = /^(enable|disable)_(staff|accounts)_addon$/.exec(action || '');
    if (addonMatch) {
      const enabled = addonMatch[1] === 'enable';
      const addonKey = addonMatch[2];
      const { error } = await supabaseAdminEngine
        .from('owner_addons')
        .upsert({
          owner_id: id,
          addon_key: addonKey,
          enabled,
          granted_by: request.headers.get('x-rentmaster-uid'),
          granted_at: new Date().toISOString(),
        }, { onConflict: 'owner_id,addon_key' });
      if (error) throw error;
      return NextResponse.json({
        success: true,
        message: `${ADDON_LABELS[addonKey]} add-on ${enabled ? 'enabled' : 'disabled'}.`,
      });
    }

    if (action === 'cancel_subscription') {
      const { data: latest } = await supabaseAdminEngine
        .from('subscription_history').select('id').eq('owner_id', id)
        .order('created_at', { ascending: false }).limit(1).maybeSingle();
      if (latest?.id) {
        await supabaseAdminEngine.from('subscription_history')
          .update({ status: 'canceled', canceled_at: new Date().toISOString() }).eq('id', latest.id);
      }
      return NextResponse.json({ success: true, message: 'Subscription canceled.' });
    }

    // --- Reset password ---
    if (password) {
      const { error } = await supabaseAdminEngine.auth.admin.updateUserById(id, { password });
      if (error) throw error;
      // Audit trail (admin-only view). Best-effort — never fail the reset over a log write.
      const ip = clientIpFrom(request.headers);
      await logPasswordReset({
        ownerId: id,
        ownerEmail: cur?.user?.email || null,
        resetBy: request.headers.get('x-rentmaster-uid'),
        method: 'admin_reset',
        ip,
      });
      // The owner did not do this and has no other way of knowing it happened — the admin still
      // has to relay the new password out-of-band, but the account holder gets told regardless.
      void notifyPasswordChanged({ ownerId: id, ownerEmail: cur?.user?.email || null, byAdmin: true, ip });
      return NextResponse.json({ success: true, message: 'Password reset successfully.' });
    }

    // --- Edit details ---
    const nextMeta = { ...meta };
    if (name !== undefined) nextMeta.name = name;
    if (phone !== undefined) nextMeta.phone = phone;
    const { error } = await supabaseAdminEngine.auth.admin.updateUserById(id, { user_metadata: nextMeta });
    if (error) throw error;
    await supabaseAdminEngine.from('user_profiles').update({
      ...(name !== undefined ? { name } : {}),
      ...(phone !== undefined ? { phone } : {}),
    }).eq('id', id);

    return NextResponse.json({ success: true, message: 'Owner details updated.' });
  } catch (err) {
    return apiError(request, err);
  }
}


// =====================================================================================
// DELETE — remove an account and everything about it, EXCEPT money paid to Bari360.
//
// The cascade itself now lives in lib/account-purge.ts, because this route may have to run it
// more than once: deleting a building admin can take every flat owner on its roster with it.
// That file also carries the history of why a four-line delete was never enough, and the list of
// tables that are deliberately preserved.
//
// TWO THINGS THIS ROUTE DECIDES, which the purge module does not:
//   1. WHO gets purged — just this account, or the whole building beneath it.
//   2. Whether it is allowed at all (self-delete, last administrator).
// =====================================================================================

/** The two answers to "this building still has owners attached". */
type MembersMode = 'delete' | 'detach';

function membersModeFrom(request: NextRequest): MembersMode | null {
  const raw = request.nextUrl.searchParams.get('members');
  return raw === 'delete' || raw === 'detach' ? raw : null;
}

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;

    // --- Guards -----------------------------------------------------------------------
    // The owners directory lists every auth user, including the admin reading it, and
    // neither the table nor this route used to stop them clicking Delete on themselves.
    if (id === request.headers.get('x-rentmaster-uid')) {
      return NextResponse.json(
        { success: false, error: 'You cannot delete the account you are signed in with.' },
        { status: 403 }
      );
    }

    const { data: targetRes, error: targetErr } = await supabaseAdminEngine.auth.admin.getUserById(id);
    if (targetErr || !targetRes?.user) {
      return NextResponse.json({ success: false, error: 'Account not found.' }, { status: 404 });
    }
    const targetRole = (targetRes.user.user_metadata as any)?.role || 'owner';

    // Never let the platform end up with no administrator — there is no way back in.
    if (targetRole === 'admin') {
      const { data: list, error: listErr } = await supabaseAdminEngine.auth.admin.listUsers({ page: 1, perPage: 1000 });
      if (listErr) throw listErr;
      const admins = (list?.users || []).filter((u) => ((u.user_metadata as any)?.role) === 'admin');
      if (admins.length <= 1) {
        return NextResponse.json(
          { success: false, error: 'This is the only administrator account. Promote another admin before deleting it.' },
          { status: 409 }
        );
      }
    }

    // --- A building admin still holding owners: ASK, do not refuse ----------------------
    // This used to be a flat 409 telling the admin to detach everyone first, which meant a
    // building could never actually be removed — there is no bulk detach, and each removal is a
    // separate confirm. The choice is real either way, so it is now made explicitly:
    //
    //   detach  the building and everything it owns goes; each flat owner keeps their login and
    //           their own properties/tenants, and falls back to the Free limits.
    //   delete  every flat owner is purged too, as if each had been deleted on their own.
    //
    // Deliberately NOT defaulted server-side. Wiping other people's accounts as a side effect of
    // an unrelated delete is exactly the kind of thing a missing query param must not decide.
    const targetBuilding = await ownedBuilding(id);
    let memberIds: string[] = [];

    if (targetBuilding) {
      // activeOnly: false — countActiveBuildingOwners() counts only is_active rows, so a
      // soft-detached owner would survive a "delete everything" and be silently left behind.
      // The admin is filtered out in case a bad roster row lists them as their own member:
      // without it the loop below would delete this account, then the code after it would try
      // again and report a failure for work that had already succeeded.
      memberIds = (await buildingOwnerIds(targetBuilding.id, false)).filter((m) => m !== id);
      const mode = membersModeFrom(request);

      if (memberIds.length && !mode) {
        return NextResponse.json(
          {
            success: false,
            code: 'BUILDING_HAS_MEMBERS',
            buildingName: targetBuilding.name,
            memberCount: memberIds.length,
            error: `"${targetBuilding.name}" still has ${memberIds.length} flat owner${memberIds.length === 1 ? '' : 's'} attached. Choose whether to delete their accounts too or detach them first.`,
          },
          { status: 409 }
        );
      }

      if (mode === 'delete') {
        // Members first: a failure part-way leaves the building itself intact, so the admin can
        // read the error, fix the cause and press Delete again. Purging the admin first would
        // leave orphaned members with no building to find them by.
        for (const memberId of memberIds) {
          const result = await purgeOwnerAccount(memberId);
          if (!result.ok) {
            return NextResponse.json(
              {
                success: false,
                error: `Could not delete a flat owner in this building — ${result.error}. Nothing further was removed; every login still exists.`,
              },
              { status: 500 }
            );
          }
          const { error: memberAuthErr } = await supabaseAdminEngine.auth.admin.deleteUser(memberId);
          if (memberAuthErr) {
            return NextResponse.json(
              {
                success: false,
                error: `A flat owner's data was removed but their login could not be deleted: ${memberAuthErr.message}`,
              },
              { status: 500 }
            );
          }
        }
      }
      // 'detach' needs no work of its own: deleting the buildings row below cascades
      // building_owners away, and each member's plan resolves to Free on their next request.
    }

    // --- The cascade -------------------------------------------------------------------
    const result = await purgeOwnerAccount(id);
    if (!result.ok) {
      return NextResponse.json(
        { success: false, error: `Could not delete the account — ${result.error}. Nothing further was removed; the login still exists.` },
        { status: 500 }
      );
    }

    // --- Finally the login itself ------------------------------------------------------
    const { error: authDeleteErr } = await supabaseAdminEngine.auth.admin.deleteUser(id);
    if (authDeleteErr) {
      console.error('[owner-delete] auth user delete failed:', authDeleteErr);
      return NextResponse.json(
        { success: false, error: `Their data was removed but the login could not be deleted: ${authDeleteErr.message}` },
        { status: 500 }
      );
    }

    // The membership cache is per-instance and 60s long, so a detached owner would otherwise
    // keep resolving through a building that no longer exists for up to a minute.
    forgetBuildingMembership(id);
    memberIds.forEach(forgetBuildingMembership);

    return NextResponse.json({
      success: true,
      message: memberIds.length && membersModeFrom(request) === 'delete'
        ? `Account deleted, along with ${memberIds.length} flat owner${memberIds.length === 1 ? '' : 's'}.`
        : 'Owner account deleted.',
      removed: { ...result.removed, members: membersModeFrom(request) === 'delete' ? memberIds.length : 0 },
    });
  } catch (err) {
    return apiError(request, err);
  }
}
