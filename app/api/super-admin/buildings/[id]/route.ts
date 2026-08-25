import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { supabaseAdminEngine } from '@/lib/supabase-server';
import { apiError } from '@/lib/api-response';
import { BUILDING_SELECT } from '@/lib/building';
import {
  buildingPlanState,
  planForBuilding,
  planBalanceOf,
  ensureBuildingSubscription,
  forgetBuildingPlan,
} from '@/lib/building-plan';

// =====================================================================================
// 👑 SUPER ADMIN — ONE BUILDING'S CONTRACT
// GET   -> the building, its contract, invoices (with line items), payments and requests.
// PATCH -> the contract terms: tenure, grace/warning windows, the pay-by deadline, an explicit
//          expiry override, and cancel / reinstate.
//
// The expiry override is the "1 year by default, but the admin can choose in special cases"
// requirement. It writes the date directly rather than going through activateBuildingTerm(),
// because a special case is by definition not derivable from a tenure.
// =====================================================================================

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function asDate(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  const s = String(value).slice(0, 10);
  return DATE_RE.test(s) ? s : undefined;
}

function asInt(value: unknown, min: number, max: number): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const n = Number(value);
  if (!Number.isFinite(n)) return undefined;
  const i = Math.round(n);
  return i >= min && i <= max ? i : undefined;
}

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;

    const { data: building, error } = await supabaseAdminEngine
      .from('buildings')
      .select(BUILDING_SELECT)
      .eq('id', id)
      .maybeSingle();
    if (error) throw error;
    if (!building) {
      return NextResponse.json({ success: false, error: 'Building not found.' }, { status: 404 });
    }

    // Seeded rather than 404'd: a building that predates this feature has no contract row, and
    // the admin opening its detail is exactly the moment to give it one.
    const subscription =
      (await planForBuilding(id)) || (await ensureBuildingSubscription(id, building.admin_id));

    const [invoicesRes, paymentsRes, requestsRes, adminRes] = await Promise.all([
      supabaseAdminEngine
        .from('building_plan_invoices')
        .select('*, items:building_plan_invoice_items ( id, label, amount, sort_order )')
        .eq('building_id', id)
        .order('created_at', { ascending: false }),
      supabaseAdminEngine
        .from('building_plan_payments')
        .select('*')
        .eq('building_id', id)
        .order('paid_on', { ascending: false }),
      supabaseAdminEngine
        .from('building_plan_requests')
        .select('*')
        .eq('building_id', id)
        .order('created_at', { ascending: false }),
      supabaseAdminEngine.auth.admin.getUserById(building.admin_id),
    ]);

    const invoices = (invoicesRes.data || []).map((inv: any) => ({
      ...inv,
      items: [...(inv.items || [])].sort((a: any, b: any) => (a.sort_order || 0) - (b.sort_order || 0)),
      balance: planBalanceOf(inv),
    }));

    return NextResponse.json(
      {
        success: true,
        data: {
          building,
          admin_login: adminRes.data?.user?.email || null,
          admin_name: (adminRes.data?.user?.user_metadata as any)?.name || null,
          admin_phone: (adminRes.data?.user?.user_metadata as any)?.phone || null,
          subscription,
          state: subscription ? buildingPlanState(subscription) : null,
          invoices,
          payments: paymentsRes.data || [],
          requests: requestsRes.data || [],
        },
      },
      { status: 200 }
    );
  } catch (err) {
    return apiError(request, err);
  }
}

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const body = await request.json();

    const { data: building } = await supabaseAdminEngine
      .from('buildings')
      .select('id, admin_id, name')
      .eq('id', id)
      .maybeSingle();
    if (!building) {
      return NextResponse.json({ success: false, error: 'Building not found.' }, { status: 404 });
    }

    const existing =
      (await planForBuilding(id)) || (await ensureBuildingSubscription(id, building.admin_id));
    if (!existing) {
      return NextResponse.json(
        { success: false, error: 'No billing contract for this building. Has ADD_BUILDING_PLANS.sql been run?' },
        { status: 409 }
      );
    }

    const patch: Record<string, any> = {};

    const termMonths = asInt(body.termMonths, 1, 120);
    if (termMonths !== undefined) patch.term_months = termMonths;

    const graceDays = asInt(body.graceDays, 0, 180);
    if (graceDays !== undefined) patch.grace_days = graceDays;

    const warnDays = asInt(body.warnDays, 0, 180);
    if (warnDays !== undefined) patch.warn_days = warnDays;

    const payBy = asDate(body.payBy);
    if (payBy === null) {
      return NextResponse.json({ success: false, error: 'A pay-by date is required.' }, { status: 400 });
    }
    if (payBy !== undefined) patch.pay_by = payBy;

    const termStartsOn = asDate(body.termStartsOn);
    if (termStartsOn !== undefined) patch.term_starts_on = termStartsOn;

    const expiryDate = asDate(body.expiryDate);
    if (expiryDate !== undefined) patch.expiry_date = expiryDate;

    if (body.notes !== undefined) patch.notes = String(body.notes ?? '').trim().slice(0, 2000) || null;

    // Marking a contract paid by hand, for a building whose money arrived before this feature
    // existed. Clearing it puts them back in the pay-by window rather than deleting history.
    if (body.markPaid === true && !existing.first_paid_at) patch.first_paid_at = new Date().toISOString();
    if (body.markPaid === false) patch.first_paid_at = null;

    if (body.action === 'cancel') patch.canceled_at = new Date().toISOString();
    if (body.action === 'reinstate') patch.canceled_at = null;

    if (!Object.keys(patch).length) {
      return NextResponse.json({ success: false, error: 'Nothing to update.' }, { status: 400 });
    }
    patch.updated_at = new Date().toISOString();

    const { data: updated, error } = await supabaseAdminEngine
      .from('building_subscriptions')
      .update(patch)
      .eq('building_id', id)
      .select('*')
      .single();
    if (error) throw error;

    // The 60-second read cache would otherwise hold the old lock state for a minute — long
    // enough for an admin to reinstate a building, watch it stay locked, and reinstate it again.
    forgetBuildingPlan(building.admin_id);

    return NextResponse.json(
      { success: true, data: { subscription: updated, state: buildingPlanState(updated as any) } },
      { status: 200 }
    );
  } catch (err) {
    return apiError(request, err);
  }
}
