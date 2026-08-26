import { NextResponse } from 'next/server';
import { supabaseAdminEngine } from '@/lib/supabase-server';

// =====================================================================================
// 💳 PLANS & PRICING (public read)
// GET -> the tiers a prospective customer may be shown, cheapest first.
//
// There was no way to see what this product costs without an account: app/page.tsx is a login
// gateway, and both existing tier reads are gated — /api/super-admin/tiers is admin-only and
// /api/admin/subscription needs an owner uid. `subscription_tiers` is RLS deny-all to anon, so
// the browser cannot read it directly either. This route is the missing public view.
//
// WHAT IS FILTERED, and why it matches what an owner sees:
//   is_active === false  -> retired; nobody is ever shown it (lib/subscription.ts:88)
//   is_public === false  -> arranged privately for one account, not listed
// That is tierVisibleToOwner() minus its one exception — "the plan I am already on stays visible
// so I can renew it" — which cannot apply to a visitor who has no plan. Filtered in JS rather
// than SQL for the same reason the owner route gives: naming `is_public` in the query would
// 42703 on a database where ADD_PLAN_VISIBILITY.sql has not run and take the whole page down,
// whereas a missing column simply reads as undefined here and the plan stays listed.
//
// ONLY PRESENTATION FIELDS ARE RETURNED. This is an unauthenticated endpoint, so it hands out
// exactly what a price card renders and nothing that describes how entitlements are enforced.
//
// Not cached at the edge: an admin who changes a price expects the next visitor to see it.
// =====================================================================================

export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'no-store' };

export async function GET() {
  try {
    const { data, error } = await supabaseAdminEngine
      .from('subscription_tiers')
      .select('*')
      .eq('is_active', true)
      .order('price', { ascending: true });
    if (error) throw error;

    const plans = (data || [])
      .filter((t: any) => t.is_public !== false)
      .map((t: any) => ({
        id: t.id,
        name: t.name,
        description: t.description ?? null,
        price: Number(t.price || 0),
        currency: t.currency || 'BDT',
        billing_interval: t.billing_interval,
        duration_days: t.duration_days ?? null,
        discount_percent: Number(t.discount_percent || 0),
        is_recurring: t.is_recurring !== false,
        staff_included: !!t.staff_included,
        accounts_included: !!t.accounts_included,
        max_properties_allowed: Number(t.max_properties_allowed ?? 0),
        max_tenants_allowed: Number(t.max_tenants_allowed ?? 0),
      }));

    return NextResponse.json(
      { success: true, count: plans.length, data: plans },
      { status: 200, headers: NO_STORE }
    );
  } catch (err: any) {
    console.error('[plans] read failed:', err);
    // Fails EMPTY, not 500: the pricing page renders its own "pricing is unavailable right now"
    // state, which is a better public face than an error, and it still shows the contact route.
    return NextResponse.json(
      { success: true, count: 0, data: [] },
      { status: 200, headers: NO_STORE }
    );
  }
}
