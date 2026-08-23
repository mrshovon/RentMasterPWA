import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { supabaseAdminEngine } from '@/lib/supabase-server';
import { assertOwnerCanWrite } from '@/lib/subscription';
import { sendPushToUsers } from '@/lib/push-send';
import { apiError } from '@/lib/api-response';
import { requireBuildingAdmin, ownerInBuilding } from '@/lib/building';
import { INVOICE_SELECT, invoiceAmountsFrom, normalizeBillingMonth } from '@/lib/building-billing';

// =====================================================================================
// 🏢 BUILDING ADMIN — SERVICE CHARGE INVOICES
// GET  -> this building's invoices (optionally filtered by ?month= or ?ownerId=)
// POST -> issue one invoice, or generate the whole month in a single pass
//         ({ billingMonth, generateAll: true }).
//
// The flat owner's own read of these lives at /api/admin/building/statement — a separate route,
// because this one is building-admin-only and must stay that way.
// =====================================================================================

export async function GET(request: NextRequest) {
  try {
    const gate = await requireBuildingAdmin(request);
    if (!gate.ok) return NextResponse.json(gate.body, { status: gate.status });

    const month = normalizeBillingMonth(request.nextUrl.searchParams.get('month'));
    const ownerFilter = request.nextUrl.searchParams.get('ownerId');

    let q = supabaseAdminEngine
      .from('building_service_invoices')
      .select(INVOICE_SELECT)
      .eq('building_id', gate.building!.id);
    if (month) q = q.eq('billing_month', month);
    if (ownerFilter) q = q.eq('owner_id', ownerFilter);

    const { data, error } = await q
      .order('billing_month', { ascending: false })
      .order('created_at', { ascending: false });
    if (error) throw error;

    return NextResponse.json(
      { success: true, count: data?.length || 0, data: data || [] },
      { status: 200 }
    );
  } catch (err) {
    return apiError(request, err);
  }
}

export async function POST(request: NextRequest) {
  try {
    const gate = await requireBuildingAdmin(request);
    if (!gate.ok) return NextResponse.json(gate.body, { status: gate.status });

    const guard = await assertOwnerCanWrite(request.headers.get('x-rentmaster-role'), gate.uid!);
    if (!guard.ok) return NextResponse.json(guard.body, { status: guard.status });

    const body = await request.json();
    const billingMonth = normalizeBillingMonth(body.billingMonth);
    if (!billingMonth) {
      return NextResponse.json(
        { success: false, error: 'A billing month in YYYY-MM form is required.' },
        { status: 400 }
      );
    }

    const buildingId = gate.building!.id;

    // ---- Generate the whole month -------------------------------------------------------
    if (body.generateAll) {
      const { data: roster, error: rosterErr } = await supabaseAdminEngine
        .from('building_owners')
        .select('owner_id, default_service_charge')
        .eq('building_id', buildingId)
        .eq('is_active', true);
      if (rosterErr) throw rosterErr;

      // Skip anyone already billed for the month rather than relying on the unique index to
      // reject them: a partial insert would leave the admin unsure who actually got billed.
      const { data: existing } = await supabaseAdminEngine
        .from('building_service_invoices')
        .select('owner_id')
        .eq('building_id', buildingId)
        .eq('billing_month', billingMonth);
      const already = new Set((existing || []).map((r: { owner_id: string }) => String(r.owner_id)));

      const toCreate = (roster || []).filter((r: any) => !already.has(String(r.owner_id)));
      if (!toCreate.length) {
        return NextResponse.json(
          {
            success: true,
            created: 0,
            skipped: already.size,
            data: [],
            message: `Every active owner already has an invoice for ${billingMonth}.`,
          },
          { status: 200 }
        );
      }

      const rows = toCreate.map((r: any) => {
        const charge = Number(r.default_service_charge || 0);
        return {
          id: crypto.randomUUID(),
          building_id: buildingId,
          admin_id: gate.uid!,
          owner_id: String(r.owner_id),
          billing_month: billingMonth,
          service_charge: charge,
          extra_charge: 0,
          discount: 0,
          total_payable: charge,
        };
      });

      const { data: created, error: insertErr } = await supabaseAdminEngine
        .from('building_service_invoices')
        .insert(rows)
        .select(INVOICE_SELECT);
      if (insertErr) throw insertErr;

      void notifyOwners(
        (created || []).map((i: any) => String(i.owner_id)),
        billingMonth
      );

      return NextResponse.json(
        { success: true, created: created?.length || 0, skipped: already.size, data: created || [] },
        { status: 201 }
      );
    }

    // ---- One invoice ---------------------------------------------------------------------
    const ownerIdParam = String(body.ownerId || '').trim();
    if (!ownerIdParam) {
      return NextResponse.json({ success: false, error: 'An owner is required.' }, { status: 400 });
    }
    if (!(await ownerInBuilding(buildingId, ownerIdParam))) {
      return NextResponse.json(
        { success: false, error: 'That owner is not in your building.' },
        { status: 404 }
      );
    }

    // Fall back to the roster's default charge when the caller didn't name one, which is what
    // makes "issue an invoice" a one-click action for the ordinary month.
    const { data: rosterRow } = await supabaseAdminEngine
      .from('building_owners')
      .select('default_service_charge')
      .eq('building_id', buildingId)
      .eq('owner_id', ownerIdParam)
      .maybeSingle();

    const amounts = invoiceAmountsFrom(body, Number(rosterRow?.default_service_charge || 0));

    const { data: created, error: insertErr } = await supabaseAdminEngine
      .from('building_service_invoices')
      .insert({
        id: crypto.randomUUID(),
        building_id: buildingId,
        admin_id: gate.uid!,
        owner_id: ownerIdParam,
        billing_month: billingMonth,
        note: body.note ? String(body.note).trim().slice(0, 1000) : null,
        ...amounts,
      })
      .select(INVOICE_SELECT)
      .single();

    if (insertErr) {
      // 23505 is the (owner_id, billing_month) unique index — the one duplicate this table has a
      // real opinion about. Say what happened instead of leaking a constraint name.
      if ((insertErr as any).code === '23505') {
        return NextResponse.json(
          { success: false, error: `That owner already has an invoice for ${billingMonth}.`, code: 'INVOICE_EXISTS' },
          { status: 409 }
        );
      }
      throw insertErr;
    }

    void notifyOwners([ownerIdParam], billingMonth);

    return NextResponse.json({ success: true, data: created }, { status: 201 });
  } catch (err) {
    return apiError(request, err);
  }
}

/** Fire-and-forget push to the owners just billed. Never allowed to fail the response — an
 *  invoice that exists but whose notification did not send is far better than the reverse. */
async function notifyOwners(ownerIds: string[], billingMonth: string): Promise<void> {
  if (!ownerIds.length) return;
  try {
    await sendPushToUsers(ownerIds, {
      title: 'New service charge invoice',
      body: `Your building service charge for ${billingMonth} is ready.`,
      url: '/owner#service-charge',
      tag: `building-invoice-${billingMonth}`,
    });
  } catch (pushErr) {
    console.error('[building-billing] push dispatch failed (non-fatal):', pushErr);
  }
}
