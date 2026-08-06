import { NextResponse } from 'next/server';
import { supabaseAdminEngine } from '@/lib/supabase-server';
import { parseTenure } from '@/lib/payments/activate';
import { parseAddons, addonColumns, rejectAddonsOnFreeTier, missingColumnFrom } from '@/lib/plan-addons';

// =====================================================================================
// 🛡️ ADMIN — SUBSCRIPTION TIER MANAGEMENT
// GET  -> all tiers (active + inactive) for the admin console
// POST -> create a new tier
// Requires the tiers migration: is_active boolean, discount_percent numeric.
// =====================================================================================
export async function GET() {
  try {
    const { data, error } = await supabaseAdminEngine
      .from('subscription_tiers')
      .select('*')
      .order('price', { ascending: true });
    if (error) throw error;
    return NextResponse.json({ success: true, count: data?.length || 0, data }, { status: 200 });
  } catch (err: any) {
    console.error('Admin Tiers GET error:', err);
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const b = await request.json();
    if (!b.id || !b.name || b.price === undefined) {
      return NextResponse.json({ success: false, error: 'id, name and price are required.' }, { status: 400 });
    }
    const billingInterval = b.billing_interval || 'month';
    const tenure = parseTenure(billingInterval, b.durationDays);
    if (!tenure.ok) {
      return NextResponse.json({ success: false, error: tenure.error }, { status: 400 });
    }

    // Which optional modules this plan bundles (subscription_tiers.<module>_included).
    const addons = parseAddons(b.addons);
    if (!addons.ok) {
      return NextResponse.json({ success: false, error: addons.error }, { status: 400 });
    }

    const tierId = String(b.id).trim().toLowerCase().replace(/[^a-z0-9_]/g, '_');
    const freeTierProblem = rejectAddonsOnFreeTier(tierId, addons.keys);
    if (freeTierProblem) {
      return NextResponse.json({ success: false, error: freeTierProblem }, { status: 400 });
    }

    const row = {
      id: tierId,
      name: b.name,
      description: b.description || null,
      price: parseFloat(b.price),
      currency: b.currency || 'BDT',
      billing_interval: billingInterval,
      duration_days: tenure.durationDays,
      max_properties_allowed: parseInt(b.maxProperties ?? -1, 10),
      max_tenants_allowed: parseInt(b.maxTenants ?? -1, 10),
      is_active: b.isActive === undefined ? true : !!b.isActive,
      // Listed to owners by default. False = hidden: admin-assign only. See ADD_PLAN_VISIBILITY.sql.
      is_public: b.isPublic === undefined ? true : !!b.isPublic,
      // Renewable by default. False = one-time (a trial). See ADD_PLAN_RECURRING.sql.
      is_recurring: b.isRecurring === undefined ? true : !!b.isRecurring,
      discount_percent: b.discountPercent !== undefined ? parseFloat(b.discountPercent) : 0,
      ...addonColumns(addons.keys),
    };
    let { data, error } = await supabaseAdminEngine.from('subscription_tiers').insert(row).select().single();

    // Pre-migration grace. Retry without whichever optional column the database doesn't have
    // yet, so plan creation keeps working, and say loudly what needs running:
    //   duration_days              -> ADD_PLAN_TENURE.sql
    //   staff/accounts_included    -> ADD_STAFF.sql / ADD_ACCOUNTS.sql
    if (['PGRST204', '42703'].includes(error?.code || '')) {
      const missing = missingColumnFrom(error.message, row);
      if (missing.length) {
        console.error(`[tiers] subscription_tiers is missing ${missing.join(', ')} — run the matching migration. Creating the plan without ${missing.length === 1 ? 'it' : 'them'}.`);
        const retry = { ...row };
        for (const col of missing) delete (retry as any)[col];
        ({ data, error } = await supabaseAdminEngine.from('subscription_tiers').insert(retry).select().single());
      }
    }

    if (error) throw error;
    return NextResponse.json({ success: true, data }, { status: 201 });
  } catch (err: any) {
    console.error('Admin Tiers POST error:', err);
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}
