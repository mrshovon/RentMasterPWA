import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { supabaseAdminEngine } from '@/lib/supabase-server';
import { apiError } from '@/lib/api-response';
import { buildingMembershipOf, flatsOfOwner, BUILDING_SELECT, type BuildingRow } from '@/lib/building';
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
//
// The payload also carries the building's PRINTABLE IDENTITY — address, letterhead, signatory and
// the building admin's signature image — because a flat owner can now print their own service
// charge receipt and statement, and an unsigned receipt is not proof of anything. That is the
// same downward exposure /api/admin/tenants/me already does with the owner's signature so a
// tenant's copy of a rent receipt is signed. Nothing private travels with it: a letterhead and a
// signature are what the building puts on paper it hands out.
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

    // --- The printable identity ------------------------------------------------------------
    // Both lookups are best-effort and independent. A receipt with no letterhead, or with the
    // rule and no signature image on it, is still a usable receipt; a 500 here would take away a
    // screen that worked before, over a decoration.
    let buildingRow: BuildingRow | null = null;
    try {
      const { data } = await supabaseAdminEngine
        .from('buildings')
        .select(BUILDING_SELECT)
        .eq('id', membership.buildingId)
        .maybeSingle();
      buildingRow = (data as BuildingRow) || null;
    } catch {
      /* non-fatal — the receipt falls back to the building's name alone */
    }

    // The signature lives on the BUILDING ADMIN's auth user_metadata, not on the buildings row
    // (ADD_BUILDINGS.sql:46 says why) — so it is fetched by uid, exactly as
    // /api/admin/owner/signature reads it.
    let signatureUrl: string | null = null;
    let ownerName: string | null = null;
    try {
      const [adminRes, selfRes] = await Promise.all([
        supabaseAdminEngine.auth.admin.getUserById(membership.adminId),
        supabaseAdminEngine.auth.admin.getUserById(uid),
      ]);
      signatureUrl = ((adminRes?.data?.user?.user_metadata as any) || {}).signature_url || null;
      ownerName = ((selfRes?.data?.user?.user_metadata as any) || {}).name || null;
    } catch {
      /* non-fatal — an unsigned receipt, and the flat label identifies the owner */
    }

    return NextResponse.json(
      {
        success: true,
        building: {
          id: membership.buildingId,
          name: membership.buildingName,
          unitLabel: membership.unitLabel,
          address: buildingRow?.address ?? null,
          city: buildingRow?.city ?? null,
          letterheadUrl: buildingRow?.letterhead_url ?? null,
          signatoryName: buildingRow?.signatory_name ?? null,
          signatoryTitle: buildingRow?.signatory_title ?? null,
          signatureUrl,
        },
        // Every flat this owner holds. `building.unitLabel` above stays populated from the
        // membership (their primary) so anything still reading the scalar keeps working; screens
        // that can show more than one flat read this instead.
        flats: await flatsOfOwner(uid, true).catch(() => []),
        owner: { name: ownerName },
        count: shaped.length,
        data: shaped,
      },
      { status: 200 }
    );
  } catch (err) {
    return apiError(request, err);
  }
}
