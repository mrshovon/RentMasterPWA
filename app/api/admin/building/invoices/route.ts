import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { supabaseAdminEngine } from '@/lib/supabase-server';
import { assertOwnerCanWrite } from '@/lib/subscription';
import { sendPushToUsers } from '@/lib/push-send';
import { apiError } from '@/lib/api-response';
import { requireBuildingAdmin, ownerInBuilding, buildingFlats, buildingOwnerIds, flatsOfOwner } from '@/lib/building';
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
      // ONE INVOICE PER FLAT. An owner who holds three flats is billed three times, so that 3B can
      // be settled while 4A is still owed — the whole reason flats exist as rows.
      //
      // buildingFlats() THROWS on a query failure rather than reading as "no flats". That matters:
      // a best-effort empty list here would report "everyone is already billed" and the admin would
      // believe a whole month had been issued when nothing had. Loud beats silent.
      const flats = await buildingFlats(buildingId, true);

      // Two independent filters on purpose. is_active is the flat's own state; the live roster is
      // the person's. A detached owner keeps inactive historical flats (ADD_BUILDING_OWNER_FLATS
      // backfills them), and neither filter alone would reliably keep those out of a billing run.
      const onRoster = new Set(await buildingOwnerIds(buildingId, true));
      const billable = flats.filter((f) => onRoster.has(f.owner_id));

      // Skip what is already billed rather than relying on the unique index to reject it: a partial
      // insert would leave the admin unsure who actually got billed.
      const { data: existing } = await supabaseAdminEngine
        .from('building_service_invoices')
        .select('flat_id, owner_id')
        .eq('building_id', buildingId)
        .eq('billing_month', billingMonth);

      const already = new Set((existing || []).map((r: any) => String(r.flat_id || '')).filter(Boolean));
      // Belt for the rollout window: an invoice written by an instance predating the flats deploy
      // has no flat_id, and re-billing that owner would double-charge them.
      const legacyOwners = new Set(
        (existing || []).filter((r: any) => !r.flat_id).map((r: any) => String(r.owner_id)),
      );

      const toCreate = billable.filter((f) => !already.has(f.id) && !legacyOwners.has(f.owner_id));
      const skipped = billable.length - toCreate.length;

      if (!toCreate.length) {
        return NextResponse.json(
          {
            success: true,
            created: 0,
            skipped,
            data: [],
            message: `Every flat already has an invoice for ${billingMonth}.`,
          },
          { status: 200 }
        );
      }

      const rows = toCreate.map((f) => {
        const charge = Number(f.default_service_charge || 0);
        return {
          id: crypto.randomUUID(),
          building_id: buildingId,
          admin_id: gate.uid!,
          owner_id: f.owner_id,
          flat_id: f.id,
          // Snapshot, so every receipt, cutting slip and accounts note can name its own flat with
          // no join — and still can once the flat row is gone. See ADD_BUILDING_OWNER_FLATS.sql.
          flat_label: f.unit_label,
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

      // Deduped: a three-flat owner gets ONE notification, not three identical ones sharing a tag.
      void notifyOwners(
        Array.from(new Set((created || []).map((i: any) => String(i.owner_id)))),
        billingMonth
      );

      return NextResponse.json(
        { success: true, created: created?.length || 0, skipped, data: created || [] },
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

    // WHICH FLAT. Named outright when the caller knows; inferred when the owner holds exactly
    // one, which keeps the ordinary one-click case working and keeps the old body shape valid.
    // Never guessed when there are several — billing the wrong flat is not recoverable by the
    // admin without deleting an invoice.
    const ownerFlats = await flatsOfOwner(ownerIdParam, true);
    const flatIdParam = String(body.flatId || '').trim();
    let flat = flatIdParam ? ownerFlats.find((f) => f.id === flatIdParam) : undefined;

    if (flatIdParam && !flat) {
      return NextResponse.json({ success: false, error: 'That flat is not on this owner.' }, { status: 404 });
    }
    if (!flat) {
      if (ownerFlats.length === 1) flat = ownerFlats[0];
      else if (ownerFlats.length === 0) {
        return NextResponse.json(
          { success: false, error: 'That owner has no flats to bill. Add one on the roster first.' },
          { status: 400 },
        );
      } else {
        return NextResponse.json(
          {
            success: false,
            code: 'FLAT_REQUIRED',
            error: `That owner holds ${ownerFlats.length} flats — say which one: ${ownerFlats.map((f) => f.unit_label || '—').join(', ')}.`,
          },
          { status: 400 },
        );
      }
    }

    // Fall back to the FLAT's default charge when the caller didn't name one, which is what makes
    // "issue an invoice" a one-click action for the ordinary month.
    const amounts = invoiceAmountsFrom(body, Number(flat.default_service_charge || 0));

    const { data: created, error: insertErr } = await supabaseAdminEngine
      .from('building_service_invoices')
      .insert({
        id: crypto.randomUUID(),
        building_id: buildingId,
        admin_id: gate.uid!,
        owner_id: ownerIdParam,
        flat_id: flat.id,
        flat_label: flat.unit_label,
        billing_month: billingMonth,
        note: body.note ? String(body.note).trim().slice(0, 1000) : null,
        ...amounts,
      })
      .select(INVOICE_SELECT)
      .single();

    if (insertErr) {
      // 23505 is a unique index, and WHICH one is worth saying. (flat_id, billing_month) is the
      // ordinary duplicate. The legacy (owner_id, billing_month) partial index can only fire while
      // a pre-flats invoice still exists for that owner that month — i.e. a half-finished
      // migration, which is an hour of confusion if the message does not name it.
      if ((insertErr as any).code === '23505') {
        const legacy = String((insertErr as any).message || '').includes('legacy_owner_month');
        return NextResponse.json(
          {
            success: false,
            code: 'INVOICE_EXISTS',
            error: legacy
              ? `That owner already has a pre-flats invoice for ${billingMonth}. Point it at a flat, or delete it, before issuing per-flat invoices for that month.`
              : `${flat.unit_label || 'That flat'} already has an invoice for ${billingMonth}.`,
          },
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
