import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { supabaseAdminEngine } from '../../../../../lib/supabase-server';
import { assertOwnerCanWrite, resolveOwnerSubscription, assertItemEnabled } from '../../../../../lib/subscription';
import { apiError } from '@/lib/api-response';

// ==============================================================================
// 🚀 PROPERTY MUTATOR: edit unit details OR vacate the unit (archiving occupancy).
// ==============================================================================
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: propertyId } = await params;
    const ownerId = request.headers.get('x-rentmaster-uid');
    const role = request.headers.get('x-rentmaster-role');

    if (!ownerId) {
      return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 });
    }
    if (!propertyId) {
      return NextResponse.json({ error: 'Property identifier missing from route context.' }, { status: 400 });
    }

    const guard = await assertOwnerCanWrite(role, ownerId);
    if (!guard.ok) return NextResponse.json(guard.body, { status: guard.status });

    const sub = await resolveOwnerSubscription(ownerId);
    const itemGuard = await assertItemEnabled(role, ownerId, sub, { propertyId });
    if (!itemGuard.ok) return NextResponse.json(itemGuard.body, { status: itemGuard.status });

    const body = await request.json();
    const { name, address, flatNo, vacate, receiptName } = body;

    // ---------------------------------------------------------------------------
    // MODE A — Vacate: snapshot each current occupant into property_occupancy_history,
    // then flag the unit vacant so it can be re-let.
    // ---------------------------------------------------------------------------
    if (vacate) {
      const { data: occupants } = await supabaseAdminEngine
        .from('tenants')
        .select('id, name, phone, rented_date')
        .eq('property_id', propertyId);

      for (const occ of occupants || []) {
        // Sum what was actually RECEIVED across every invoice, not the face value of the ones
        // marked paid — a partly-paid invoice contributes the part that was paid.
        const { data: ledgerRows } = await supabaseAdminEngine
          .from('billing_ledgers')
          .select('amount_paid')
          .eq('tenant_id', occ.id);
        const totalRentPaid = (ledgerRows || []).reduce((s, l) => s + Number(l.amount_paid || 0), 0);

        const { error: archiveError } = await supabaseAdminEngine
          .from('property_occupancy_history')
          .insert([
            {
              property_id: propertyId,
              tenant_name: occ.name,
              tenant_phone: occ.phone,
              lease_start: occ.rented_date || null,
              lease_end: new Date().toISOString().slice(0, 10),
              total_rent_paid: totalRentPaid,
            },
          ]);
        if (archiveError) console.error('Occupancy archive warning:', archiveError.message);
      }

      const { data: vacated, error: vacateError } = await supabaseAdminEngine
        .from('properties')
        .update({ is_vacant: true })
        .eq('id', propertyId)
        .eq('owner_id', ownerId)
        .select()
        .single();

      if (vacateError) {
        return apiError(request, vacateError);
      }

      // Detach the occupants. Without this the unit reads "vacant" while its tenants still
      // point at it — they'd stay billable and keep showing up in the invoice picker. They
      // keep their record and can be re-assigned to another unit.
      if ((occupants || []).length) {
        const { error: detachError } = await supabaseAdminEngine
          .from('tenants')
          .update({ property_id: null })
          .eq('property_id', propertyId);
        if (detachError) console.error('Tenant detach warning:', detachError.message);
      }

      return NextResponse.json({ success: true, message: 'Property marked vacant; occupancy archived.', data: vacated }, { status: 200 });
    }

    // ---------------------------------------------------------------------------
    // MODE B — Edit details
    // ---------------------------------------------------------------------------
    const updates: Record<string, any> = {};
    if (name !== undefined) updates.name = name;
    if (address !== undefined) updates.address = address;
    if (flatNo !== undefined) updates.flat_no = flatNo;
    // Cleared back to null = fall back to the owner's account name on this property's receipts.
    if (receiptName !== undefined) updates.receipt_name = String(receiptName ?? '').trim() || null;

    if (Object.keys(updates).length === 0) {
      return NextResponse.json({ error: 'No editable fields supplied.' }, { status: 400 });
    }

    const { data: updated, error: updateError } = await supabaseAdminEngine
      .from('properties')
      .update(updates)
      .eq('id', propertyId)
      .eq('owner_id', ownerId)
      .select()
      .single();

    if (updateError) {
      return apiError(request, updateError);
    }

    return NextResponse.json({ success: true, data: updated }, { status: 200 });

  } catch (runtimeExceptionCatch) {
    return apiError(request, runtimeExceptionCatch);
  }
}
