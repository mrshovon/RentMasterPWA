import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { supabaseAdminEngine } from '@/lib/supabase-server';
import { logPasswordReset, notifyPasswordChanged, clientIpFrom } from '@/lib/password-reset-log';
import { getPresenceFor } from '@/lib/presence';
import { apiError } from '@/lib/api-response';

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
// DELETE — remove an owner and everything they own.
//
// This used to be four lines: `auth.admin.deleteUser(id)` then a fire-and-forget
// `user_profiles` delete. It did not work, and worse, it *reported* that it did:
//
//   1. FK deadlock. `tenants.owner_id` and `properties.owner_id` reference
//      `user_profiles (id)` with no ON DELETE clause (see FIX_PUSH_AND_TENANT_MOVE.sql),
//      i.e. NO ACTION. Deleting the auth user cascades into user_profiles and trips those
//      FKs, so GoTrue aborts with "Database error deleting user" for any owner who has
//      data — which is every real owner.
//   2. The `user_profiles` delete result was discarded, so a failure there still returned
//      `success: true` / "Owner account deleted."
//   3. Nothing cleaned up the owner's rows. Several tables (staff, reminders,
//      contact_messages, notices.target_owner_id, device_tokens.user_id) are deliberately
//      NOT foreign keys — see ADD_STAFF.sql — so they would silently orphan against a
//      dead uuid rather than raise.
//
// So: delete children before parents, check every error, and only then remove the auth
// user. Tables belonging to modules whose migration has not been run yet are skipped
// rather than fatal (MIGRATIONS.md still lists several as unapplied), the same spirit as
// the 42703 fallback in /api/admin/notices.
// =====================================================================================

// "This table/column isn't in the schema" — an optional module whose migration was never
// run. Nothing to delete, so skipping is correct.
//
// PGRST205/PGRST204 are what actually come back: supabase-js talks to PostgREST, which
// resolves names against its own schema cache and answers with its own codes rather than
// Postgres's 42P01/42703. Both sets are listed because only the PGRST ones are observed in
// practice, and missing either would turn "module not installed" into a hard delete failure.
const MISSING_SCHEMA_CODES = ['PGRST205', 'PGRST204', '42P01', '42703'];

interface PurgeStep { table: string; column: string; values: string[] }

/**
 * Delete `table` rows whose `column` is in `values`. Returns the step outcome instead of
 * throwing so the caller can report exactly which table failed.
 */
async function purge({ table, column, values }: PurgeStep): Promise<{ skipped: boolean; error?: string }> {
  if (!values.length) return { skipped: true };
  const { error } = await supabaseAdminEngine.from(table).delete().in(column, values);
  if (!error) return { skipped: false };
  if (MISSING_SCHEMA_CODES.includes(error.code || '')) {
    console.warn(`[owner-delete] skipping ${table}.${column} — not in the schema (${error.code}). Unapplied migration?`);
    return { skipped: true };
  }
  return { skipped: false, error: `${table}.${column}: ${error.message}` };
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

    // --- Collect the id sets the child tables are keyed on -----------------------------
    const { data: propRows, error: propErr } = await supabaseAdminEngine
      .from('properties').select('id').eq('owner_id', id);
    if (propErr) throw propErr;
    const propertyIds = (propRows || []).map((p: { id: string }) => String(p.id));

    const { data: tenantRows, error: tenantErr } = await supabaseAdminEngine
      .from('tenants').select('id').eq('owner_id', id);
    if (tenantErr) throw tenantErr;
    const tenantIds = (tenantRows || []).map((t: { id: string }) => String(t.id));

    // billing_payments hangs off the ledger, not the owner.
    let ledgerIds: string[] = [];
    const { data: ledgerRows, error: ledgerErr } = await supabaseAdminEngine
      .from('billing_ledgers').select('id').eq('created_by_owner', id);
    if (ledgerErr && !MISSING_SCHEMA_CODES.includes(ledgerErr.code || '')) throw ledgerErr;
    if (ledgerRows) ledgerIds = ledgerRows.map((l: { id: string }) => String(l.id));

    const owned = [id];

    // --- The cascade, children first ---------------------------------------------------
    // Order matters: anything with a real FK must go before its parent, and the auth user
    // (which cascades into user_profiles) goes dead last.
    const steps: PurgeStep[] = [
      // Money: payments -> ledgers, then the bookkeeping module.
      { table: 'billing_payments',           column: 'ledger_id',        values: ledgerIds },
      { table: 'billing_ledgers',            column: 'created_by_owner', values: owned },
      { table: 'account_transactions',       column: 'owner_id',         values: owned },
      { table: 'account_transfers',          column: 'owner_id',         values: owned },
      { table: 'accounts',                   column: 'owner_id',         values: owned },
      // Staff module.
      { table: 'staff_payments',             column: 'owner_id',         values: owned },
      { table: 'staff',                      column: 'owner_id',         values: owned },
      // Per-tenant and per-property records.
      { table: 'reminders',                  column: 'owner_id',         values: owned },
      { table: 'documents',                  column: 'tenant_id',        values: tenantIds },
      { table: 'rent_revision_archives',     column: 'tenant_id',        values: tenantIds },
      { table: 'service_charge_breakdowns',  column: 'property_id',      values: propertyIds },
      { table: 'property_occupancy_history', column: 'property_id',      values: propertyIds },
      { table: 'maintenance_logs',           column: 'property_id',      values: propertyIds },
      // Notices: written by them, addressed to them, or addressed to one of their tenants.
      { table: 'notices',                    column: 'sender_id',        values: owned },
      { table: 'notices',                    column: 'target_owner_id',  values: owned },
      { table: 'notices',                    column: 'target_tenant_id', values: tenantIds },
      // Push endpoints are keyed by text user_id holding either an owner uid or a tenant id.
      { table: 'device_tokens',              column: 'user_id',          values: [...owned, ...tenantIds] },
      // Now the parents.
      { table: 'tenants',                    column: 'owner_id',         values: owned },
      { table: 'properties',                 column: 'owner_id',         values: owned },
      // Account-level records.
      { table: 'subscription_history',       column: 'owner_id',         values: owned },
      { table: 'owner_addons',               column: 'owner_id',         values: owned },
      { table: 'payment_submissions',        column: 'owner_id',         values: owned },
      { table: 'support_tickets',            column: 'owner_id',         values: owned },
      { table: 'contact_messages',           column: 'owner_id',         values: owned },
      { table: 'password_reset_history',     column: 'owner_id',         values: owned },
      { table: 'user_profiles',              column: 'id',               values: owned },
    ];

    for (const step of steps) {
      const { error } = await purge(step);
      if (error) {
        // Stop here rather than press on: a half-cascaded account is easier to reason
        // about than one where an unknown subset survived, and the auth user still exists
        // so the admin can retry once the cause is fixed.
        console.error('[owner-delete] cascade failed at', error);
        return NextResponse.json(
          { success: false, error: `Could not delete the account — ${error}. Nothing further was removed; the login still exists.` },
          { status: 500 }
        );
      }
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

    return NextResponse.json({
      success: true,
      message: 'Owner account deleted.',
      removed: { properties: propertyIds.length, tenants: tenantIds.length, invoices: ledgerIds.length },
    });
  } catch (err) {
    return apiError(request, err);
  }
}
