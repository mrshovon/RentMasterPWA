import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { supabaseAdminEngine } from '@/lib/supabase-server';
import { assertOwnerCanWrite } from '@/lib/subscription';
import { apiError } from '@/lib/api-response';
import { flatToken } from '@/lib/validate';
import {
  requireBuildingAdmin,
  ownerInBuilding,
  flatInBuilding,
  flatsOfOwner,
  BUILDING_FLAT_SELECT,
} from '@/lib/building';

// =====================================================================================
// 🏢 BUILDING ADMIN — ONE FLAT
// PATCH  -> rename it, re-price it, deactivate it, or make it the primary.
// DELETE -> remove it, but only while it has no invoices.
//
// EVERY HANDLER CHECKS TWICE: that the owner is on this building's roster, and that the flat's own
// building_id matches. A guessed flatId belonging to another building must read as not-found, not
// as someone else's flat renamed.
//
// THE PROPERTY BEHIND A FLAT IS NEVER DELETED HERE. A tenant, their rent invoices, their receipts
// and the account transactions behind them all hang off properties.id. Removing a flat from a
// service-charge roster is a statement about who the BUILDING bills — it is not a statement that a
// year of the owner's own rent history should stop existing. The flat row lets go of the property;
// the property carries on in the owner's dashboard exactly as it was.
// =====================================================================================

async function guard(request: NextRequest, ownerId: string, flatId: string) {
  const gate = await requireBuildingAdmin(request);
  if (!gate.ok) return { err: NextResponse.json(gate.body, { status: gate.status }) };

  if (!(await ownerInBuilding(gate.building!.id, ownerId))) {
    return { err: NextResponse.json({ success: false, error: 'That owner is not on this building.' }, { status: 404 }) };
  }
  const flat = await flatInBuilding(gate.building!.id, flatId);
  if (!flat || flat.owner_id !== ownerId) {
    return { err: NextResponse.json({ success: false, error: 'That flat is not on this owner.' }, { status: 404 }) };
  }
  return { gate, flat };
}

export async function PATCH(
  request: NextRequest,
  ctx: { params: Promise<{ id: string; flatId: string }> },
) {
  try {
    const { id, flatId } = await ctx.params;
    const g = await guard(request, id, flatId);
    if ('err' in g) return g.err;

    const writeGuard = await assertOwnerCanWrite(request.headers.get('x-rentmaster-role'), g.gate.uid!);
    if (!writeGuard.ok) return NextResponse.json(writeGuard.body, { status: writeGuard.status });

    const body = await request.json();
    const fields: Record<string, any> = { updated_at: new Date().toISOString() };

    if (body.unitLabel !== undefined) {
      const label = String(body.unitLabel || '').trim().slice(0, 120);
      if (!label) return NextResponse.json({ success: false, error: 'The flat needs a number.' }, { status: 400 });
      fields.unit_label = label;
      fields.flat_no = flatToken(label) || null;
    }
    if (body.defaultServiceCharge !== undefined) {
      fields.default_service_charge = Number(body.defaultServiceCharge || 0) || 0;
    }
    if (body.isActive !== undefined) {
      fields.is_active = !!body.isActive;
      // A deactivated flat cannot stay primary — the partial unique index is scoped to is_active,
      // so leaving the flag set would silently block the replacement from claiming it.
      if (!fields.is_active) fields.is_primary = false;
    }

    // Making this flat the primary demotes the current one in the same request. Order matters:
    // clear first, then set, or building_owner_flats_primary_idx rejects the second write.
    if (body.isPrimary === true) {
      if (fields.is_active === false) {
        return NextResponse.json(
          { success: false, error: 'A deactivated flat cannot be the primary one.' },
          { status: 400 },
        );
      }
      await supabaseAdminEngine
        .from('building_owner_flats')
        .update({ is_primary: false, updated_at: new Date().toISOString() })
        .eq('building_id', g.gate.building!.id)
        .eq('owner_id', id);
      fields.is_primary = true;
    }

    const { data, error } = await supabaseAdminEngine
      .from('building_owner_flats')
      .update(fields)
      .eq('id', flatId)
      .eq('owner_id', id)
      .select(BUILDING_FLAT_SELECT)
      .single();
    if (error) throw error;

    // building_owners.unit_label / .flat_no mirror the PRIMARY flat, so every read path still keyed
    // on the owner degrades to "their main flat" rather than to null. This does NOT change how they
    // sign in — the identifier was frozen at creation.
    if (data?.is_primary) {
      await supabaseAdminEngine
        .from('building_owners')
        .update({ unit_label: data.unit_label, flat_no: data.flat_no, updated_at: new Date().toISOString() })
        .eq('building_id', g.gate.building!.id)
        .eq('owner_id', id);
    }

    return NextResponse.json({ success: true, data, message: 'Flat updated.' }, { status: 200 });
  } catch (err) {
    return apiError(request, err);
  }
}

export async function DELETE(
  request: NextRequest,
  ctx: { params: Promise<{ id: string; flatId: string }> },
) {
  try {
    const { id, flatId } = await ctx.params;
    const g = await guard(request, id, flatId);
    if ('err' in g) return g.err;

    const writeGuard = await assertOwnerCanWrite(request.headers.get('x-rentmaster-role'), g.gate.uid!);
    if (!writeGuard.ok) return NextResponse.json(writeGuard.body, { status: writeGuard.status });

    // A flat with invoices is history, not a roster entry. Deleting it would leave those invoices
    // pointing at nothing — readable, because of the flat_label snapshot, but ungroupable. The
    // admin is told to deactivate instead, which is what they almost always mean.
    const { count } = await supabaseAdminEngine
      .from('building_service_invoices')
      .select('id', { count: 'exact', head: true })
      .eq('flat_id', flatId);

    if ((count || 0) > 0) {
      return NextResponse.json(
        {
          success: false,
          code: 'FLAT_HAS_INVOICES',
          error: `This flat has ${count} invoice(s), so it cannot be deleted. Deactivate it instead — it stops being billed and its history stays.`,
        },
        { status: 409 },
      );
    }

    const wasPrimary = g.flat.is_primary;
    const { error } = await supabaseAdminEngine
      .from('building_owner_flats')
      .delete()
      .eq('id', flatId)
      .eq('owner_id', id);
    if (error) throw error;

    // Someone has to be primary while any flat is left, or the roster's owner-keyed fallbacks
    // resolve to null. The oldest surviving active flat takes it.
    if (wasPrimary) {
      const left = (await flatsOfOwner(id, true))[0];
      if (left) {
        await supabaseAdminEngine
          .from('building_owner_flats')
          .update({ is_primary: true, updated_at: new Date().toISOString() })
          .eq('id', left.id);
        await supabaseAdminEngine
          .from('building_owners')
          .update({ unit_label: left.unit_label, flat_no: left.flat_no, updated_at: new Date().toISOString() })
          .eq('building_id', g.gate.building!.id)
          .eq('owner_id', id);
      }
    }

    return NextResponse.json(
      {
        success: true,
        message: g.flat.property_id
          ? 'Flat removed. Its property, tenant and rent history stay in the owner’s own dashboard.'
          : 'Flat removed.',
      },
      { status: 200 },
    );
  } catch (err) {
    return apiError(request, err);
  }
}
