import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { supabaseAdminEngine } from '@/lib/supabase-server';
import { apiError } from '@/lib/api-response';
import { buildingMembershipOf } from '@/lib/building';
import { INVOICE_SELECT } from '@/lib/building-billing';

// =====================================================================================
// 🧾 FLAT OWNER — MY SERVICE CHARGE STATEMENT
// GET -> the invoices this owner has been issued by their building, plus the payments recorded
//        against each one, plus the building's identity.
//
// A SEPARATE route from /api/admin/building/invoices on purpose. That one is building-admin-only
// and must stay that way; this one is scoped by the caller's OWN membership, so there is no path
// through it to another owner's figures. Read-only by design — a flat owner never records money
// against their own invoice, the building admin does.
//
// The route is deliberately not gated on requireBuildingAdmin: its caller is an ordinary owner.
// Membership IS the authorisation, and every query below is filtered by the caller's uid.
// =====================================================================================

function ownerId(request: NextRequest): string | null {
  const id = request.headers.get('x-rentmaster-uid');
  if (!id || id === 'YOUR_ACTUAL_USER_UUID_FROM_DATABASE') return null;
  return id;
}

export async function GET(request: NextRequest) {
  try {
    const uid = ownerId(request);
    if (!uid) return NextResponse.json({ error: 'Context matching identity missing.' }, { status: 400 });

    // A tenant token carries no x-rentmaster-uid, so it never reaches this line — but a tenant id
    // is checked for explicitly rather than relying on that, because it is one middleware change
    // away from being untrue.
    if (request.headers.get('x-rentmaster-tenant-id')) {
      return NextResponse.json({ success: false, error: 'Not available for tenants.' }, { status: 403 });
    }

    const membership = await buildingMembershipOf(uid);
    if (!membership) {
      // Not in a building is not an error — the owner dashboard asks unconditionally and hides
      // the tab when this comes back empty.
      return NextResponse.json(
        { success: true, building: null, count: 0, data: [] },
        { status: 200 }
      );
    }

    const { data: invoices, error } = await supabaseAdminEngine
      .from('building_service_invoices')
      .select(INVOICE_SELECT)
      .eq('owner_id', uid)
      .order('billing_month', { ascending: false });
    if (error) throw error;

    // Payments for all of them in ONE query, then grouped in memory — a per-invoice fetch would
    // be a round trip per row on a screen that shows a year of them.
    const ids = (invoices || []).map((i: any) => String(i.id));
    let byInvoice: Record<string, any[]> = {};
    if (ids.length) {
      const { data: payments } = await supabaseAdminEngine
        .from('building_service_payments')
        .select('*')
        .in('invoice_id', ids)
        .order('paid_on', { ascending: true });
      byInvoice = (payments || []).reduce((acc: Record<string, any[]>, p: any) => {
        (acc[String(p.invoice_id)] ||= []).push(p);
        return acc;
      }, {});
    }

    const shaped = (invoices || []).map((i: any) => ({ ...i, payments: byInvoice[String(i.id)] || [] }));

    return NextResponse.json(
      {
        success: true,
        building: {
          id: membership.buildingId,
          name: membership.buildingName,
          unitLabel: membership.unitLabel,
        },
        count: shaped.length,
        data: shaped,
      },
      { status: 200 }
    );
  } catch (err) {
    return apiError(request, err);
  }
}
