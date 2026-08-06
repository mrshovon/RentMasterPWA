import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { supabaseAdminEngine } from '@/lib/supabase-server';
import { parseTenure } from '@/lib/payments/activate';
import {
  parseAddons, addonColumns, addonsOnTier, rejectAddonsOnFreeTier,
  countOwnersLosingAddons, describeAffected, missingColumnFrom,
} from '@/lib/plan-addons';

// =====================================================================================
// 🛡️ ADMIN — SINGLE TIER: edit fields / activate|deactivate / set discount / delete
// =====================================================================================
export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const b = await request.json();

    const updates: Record<string, any> = {};
    if (b.name !== undefined) updates.name = b.name;
    if (b.description !== undefined) updates.description = b.description || null;
    if (b.price !== undefined) updates.price = parseFloat(b.price);
    if (b.currency !== undefined) updates.currency = b.currency;
    if (b.billing_interval !== undefined) updates.billing_interval = b.billing_interval;
    if (b.maxProperties !== undefined) updates.max_properties_allowed = parseInt(b.maxProperties, 10);
    if (b.maxTenants !== undefined) updates.max_tenants_allowed = parseInt(b.maxTenants, 10);
    if (b.discountPercent !== undefined) updates.discount_percent = parseFloat(b.discountPercent);
    if (b.isActive !== undefined) updates.is_active = !!b.isActive;
    if (b.action === 'activate') updates.is_active = true;
    if (b.action === 'deactivate') updates.is_active = false;

    // Tenure. Re-validated whenever either half changes, because they constrain each other:
    // switching to 'days' requires a duration, and switching away from it must clear the old
    // one so a plan changed from "7 days" back to Monthly doesn't keep a stale 7.
    if (b.billing_interval !== undefined || b.durationDays !== undefined) {
      let interval = b.billing_interval;
      if (interval === undefined) {
        const { data: cur } = await supabaseAdminEngine
          .from('subscription_tiers').select('billing_interval').eq('id', id).maybeSingle();
        interval = cur?.billing_interval;
      }
      const tenure = parseTenure(interval, b.durationDays);
      if (!tenure.ok) {
        return NextResponse.json({ success: false, error: tenure.error }, { status: 400 });
      }
      updates.duration_days = tenure.durationDays;
    }

    // Which optional modules this plan bundles. Only touched when `addons` is sent, so an
    // unrelated PATCH (rename, activate/deactivate) never disturbs the module flags.
    if (b.addons !== undefined) {
      const addons = parseAddons(b.addons);
      if (!addons.ok) {
        return NextResponse.json({ success: false, error: addons.error }, { status: 400 });
      }
      const freeTierProblem = rejectAddonsOnFreeTier(id, addons.keys);
      if (freeTierProblem) {
        return NextResponse.json({ success: false, error: freeTierProblem }, { status: 400 });
      }

      // Removing a module takes it away from everyone on this plan the moment it saves — the
      // tier flag is read live on every request (lib/features.ts). So find out who actually
      // loses access and make the admin confirm before doing it.
      const { data: current } = await supabaseAdminEngine
        .from('subscription_tiers').select('*').eq('id', id).maybeSingle();
      const removed = addonsOnTier(current).filter((key) => !addons.keys.includes(key));

      if (removed.length && !b.confirmAddonRemoval) {
        const affected = await countOwnersLosingAddons(id, removed);
        if (Object.keys(affected).length) {
          return NextResponse.json({
            success: false,
            code: 'ADDON_REMOVAL_AFFECTS_OWNERS',
            affected,
            error: `Removing ${describeAffected(affected)} from this plan takes that access away immediately.`,
          }, { status: 409 });
        }
      }

      Object.assign(updates, addonColumns(addons.keys));
    }

    if (Object.keys(updates).length === 0) {
      return NextResponse.json({ success: false, error: 'No fields to update.' }, { status: 400 });
    }

    let { data, error } = await supabaseAdminEngine
      .from('subscription_tiers').update(updates).eq('id', id).select().single();

    // Pre-migration grace, same as the create route: retry without whichever optional column
    // this database doesn't have yet (duration_days -> ADD_PLAN_TENURE.sql, the *_included
    // flags -> ADD_STAFF.sql / ADD_ACCOUNTS.sql) so plan editing keeps working regardless.
    if (['PGRST204', '42703'].includes(error?.code || '')) {
      const missing = missingColumnFrom(error.message, updates);
      if (missing.length) {
        console.error(`[tiers] subscription_tiers is missing ${missing.join(', ')} — run the matching migration. Saving without ${missing.length === 1 ? 'it' : 'them'}.`);
        const retry = { ...updates };
        for (const col of missing) delete retry[col];
        ({ data, error } = await supabaseAdminEngine
          .from('subscription_tiers').update(retry).eq('id', id).select().single());
      }
    }

    if (error) throw error;
    return NextResponse.json({ success: true, data }, { status: 200 });
  } catch (err: any) {
    console.error('Admin Tier PATCH error:', err);
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}

export async function DELETE(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const { error } = await supabaseAdminEngine.from('subscription_tiers').delete().eq('id', id);
    if (error) {
      // Likely referenced by subscription_history — advise deactivating instead.
      return NextResponse.json({ success: false, error: `${error.message} (tip: deactivate the plan instead of deleting it).` }, { status: 409 });
    }
    return NextResponse.json({ success: true, message: 'Tier deleted.' }, { status: 200 });
  } catch (err: any) {
    console.error('Admin Tier DELETE error:', err);
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}
