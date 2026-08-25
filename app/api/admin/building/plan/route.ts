import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { supabaseAdminEngine } from '@/lib/supabase-server';
import { apiError } from '@/lib/api-response';
import { requireBuildingAdmin } from '@/lib/building';
import { buildingPlanState, planForBuilding, planBalanceOf } from '@/lib/building-plan';

// =====================================================================================
// 🏢💳 BUILDING ADMIN — MY PLAN
// GET -> the building's contract state, its invoices with line items, its payment history
//        (which is the receipts list) and any open request.
//
// ⚠️ DELIBERATELY NO assertOwnerCanWrite() ON THIS ROUTE.
// A locked building is precisely who needs to reach this screen — it is where the bill, the
// payment link and the "I have paid" button live. Gating it on the lock it exists to lift would
// be a closed loop. Same reasoning, and the same standing exception, as
// app/api/admin/payments/route.ts and app/api/admin/contact-messages/route.ts.
//
// requireBuildingAdmin() is still the first line: /api/admin/* is authenticated, not authorized.
// =====================================================================================

export async function GET(request: NextRequest) {
  try {
    const gate = await requireBuildingAdmin(request);
    if (!gate.ok) return NextResponse.json(gate.body, { status: gate.status });

    const buildingId = gate.building!.id;
    const subscription = await planForBuilding(buildingId);

    // A building with no contract row predates this feature (or its seed failed). It resolves as
    // perpetual everywhere else, so the honest answer here is "no contract", not an error.
    if (!subscription) {
      return NextResponse.json(
        { success: true, data: { subscription: null, state: null, invoices: [], payments: [], requests: [] } },
        { status: 200 }
      );
    }

    const [invoicesRes, paymentsRes, requestsRes] = await Promise.all([
      supabaseAdminEngine
        .from('building_plan_invoices')
        .select('*, items:building_plan_invoice_items ( id, label, amount, sort_order )')
        .eq('building_id', buildingId)
        .neq('status', 'draft')      // a draft is ours, not theirs — never show a half-written quote
        .order('created_at', { ascending: false }),
      supabaseAdminEngine
        .from('building_plan_payments')
        .select('*')
        .eq('building_id', buildingId)
        .order('paid_on', { ascending: false }),
      supabaseAdminEngine
        .from('building_plan_requests')
        .select('*')
        .eq('building_id', buildingId)
        .order('created_at', { ascending: false })
        .limit(20),
    ]);

    const invoices = (invoicesRes.data || []).map((inv: any) => ({
      ...inv,
      items: [...(inv.items || [])].sort((a: any, b: any) => (a.sort_order || 0) - (b.sort_order || 0)),
      balance: planBalanceOf(inv),
    }));

    // The bill they are being asked to settle: the newest invoice that still has money owing.
    const current = invoices.find((i: any) => i.payment_status !== 'paid' && i.status !== 'void') || null;

    return NextResponse.json(
      {
        success: true,
        data: {
          subscription,
          state: buildingPlanState(subscription),
          currentInvoiceId: current?.id || null,
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
