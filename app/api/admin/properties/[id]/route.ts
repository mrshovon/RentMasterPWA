import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { supabaseAdminEngine } from '../../../../../lib/supabase-server';
import { assertOwnerCanWrite, resolveOwnerSubscription, assertItemEnabled } from '../../../../../lib/subscription';

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
    const { name, address, flatNo, vacate } = body;

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
        const { data: paidLedgers } = await supabaseAdminEngine
          .from('billing_ledgers')
          .select('total_payable')
          .eq('tenant_id', occ.id)
          .eq('payment_status', 'paid');
        const totalRentPaid = (paidLedgers || []).reduce((s, l) => s + Number(l.total_payable || 0), 0);

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
        console.error('Supabase Property Vacate Error:', vacateError);
        return NextResponse.json({ error: vacateError.message }, { status: 500 });
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
      console.error('Supabase Property Update Error:', updateError);
      return NextResponse.json({ error: updateError.message }, { status: 500 });
    }

    return NextResponse.json({ success: true, data: updated }, { status: 200 });

  } catch (runtimeExceptionCatch: any) {
    console.error('Fatal Pipeline Execution Property PATCH Route Crash:', runtimeExceptionCatch);
    return NextResponse.json({ error: runtimeExceptionCatch.message || 'Fatal Server Logic Exception.' }, { status: 500 });
  }
}
