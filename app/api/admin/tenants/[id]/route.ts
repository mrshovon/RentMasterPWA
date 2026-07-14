import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { supabaseAdminEngine } from '../../../../../lib/supabase-server';
import { assertOwnerCanWrite, resolveOwnerSubscription, assertItemEnabled } from '../../../../../lib/subscription';
import { generatePasscode, hashPasscode } from '../../../../../lib/passcode';

// ==============================================================================
// 🚀 TENANT MUTATOR: edit tenant details / revise rent. A rent change is journaled
// into rent_revision_archives for an auditable history.
// ==============================================================================
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: tenantId } = await params;
    const ownerId = request.headers.get('x-rentmaster-uid');
    const role = request.headers.get('x-rentmaster-role');

    if (!ownerId) {
      return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 });
    }
    if (!tenantId) {
      return NextResponse.json({ error: 'Tenant identifier missing from route context.' }, { status: 400 });
    }

    const guard = await assertOwnerCanWrite(role, ownerId);
    if (!guard.ok) return NextResponse.json(guard.body, { status: guard.status });

    const sub = await resolveOwnerSubscription(ownerId);
    const itemGuard = await assertItemEnabled(role, ownerId, sub, { tenantId });
    if (!itemGuard.ok) return NextResponse.json(itemGuard.body, { status: itemGuard.status });

    const body = await request.json();
    const {
      name, phone, monthlyRent, serviceCharge, advanceAmount, dueDate, familyMembers, propertyId,
      allowLoginUnassigned,
    } = body;

    // 1. Load current record for a governance check and old_rent capture. Ownership is
    // read from tenants.owner_id (not the property) so an unassigned tenant — one with
    // no property_id — is still scoped to exactly one owner.
    const { data: current, error: currentError } = await supabaseAdminEngine
      .from('tenants')
      .select('*')
      .eq('id', tenantId)
      .single();

    if (currentError || !current) {
      return NextResponse.json({ error: currentError?.message || 'Tenant not found.' }, { status: 404 });
    }
    if (current.owner_id !== ownerId) {
      return NextResponse.json({ error: 'This tenant does not belong to your portfolio.' }, { status: 403 });
    }

    // 1b. Passcode reset — issue a fresh random passcode and return the plaintext once.
    if (body.resetPasscode) {
      const rawPasscode = generatePasscode();
      const { error: pErr } = await supabaseAdminEngine
        .from('tenants')
        .update({ password_hash: hashPasscode(rawPasscode) })
        .eq('id', tenantId);
      if (pErr) return NextResponse.json({ error: 'Could not reset passcode.' }, { status: 500 });
      return NextResponse.json({ success: true, passcode: rawPasscode, message: 'Passcode reset.' }, { status: 200 });
    }

    // 2. Assemble the update set from provided fields only.
    const updates: Record<string, any> = {};
    if (name !== undefined) updates.name = name;
    if (phone !== undefined) updates.phone = phone;
    if (monthlyRent !== undefined) updates.monthly_rent = parseFloat(monthlyRent);
    if (serviceCharge !== undefined) updates.service_charge = parseFloat(serviceCharge);
    if (advanceAmount !== undefined) updates.advance_amount = parseFloat(advanceAmount);
    if (dueDate !== undefined) updates.due_date = parseInt(dueDate, 10);
    if (familyMembers !== undefined) updates.family_members = parseInt(familyMembers, 10);
    // Owner's override letting an unassigned tenant keep portal access (see lib/tenant-access.ts).
    if (allowLoginUnassigned !== undefined) updates.allow_login_unassigned = !!allowLoginUnassigned;

    // 2b. Property (re)assignment. A null/empty propertyId unassigns the tenant (they
    // keep their record and history); a new id moves them. The unit they leave is freed
    // and the one they enter is occupied — see step 4.
    let propertyBeingLeft: string | null = null;
    if (propertyId !== undefined && propertyId !== current.property_id) {
      if (!propertyId) {
        updates.property_id = null;
      } else {
        const { data: target } = await supabaseAdminEngine
          .from('properties')
          .select('id, owner_id')
          .eq('id', propertyId)
          .maybeSingle();

        if (!target) {
          return NextResponse.json({ error: 'That property does not exist.' }, { status: 404 });
        }
        if (target.owner_id !== ownerId) {
          return NextResponse.json({ error: 'That property does not belong to your portfolio.' }, { status: 403 });
        }

        const { data: occupant } = await supabaseAdminEngine
          .from('tenants')
          .select('name')
          .eq('property_id', propertyId)
          .neq('id', tenantId)
          .maybeSingle();
        if (occupant) {
          return NextResponse.json(
            { error: `${occupant.name} already occupies that property. Vacate it first.` },
            { status: 409 }
          );
        }
        updates.property_id = propertyId;
      }
      propertyBeingLeft = current.property_id;
    }

    if (Object.keys(updates).length === 0) {
      return NextResponse.json({ error: 'No editable fields supplied.' }, { status: 400 });
    }

    const { data: updated, error: updateError } = await supabaseAdminEngine
      .from('tenants')
      .update(updates)
      .eq('id', tenantId)
      .select()
      .single();

    if (updateError) {
      console.error('Supabase Tenant Update Error:', updateError);
      return NextResponse.json({ error: updateError.message }, { status: 500 });
    }

    // 3. Journal a rent revision when the monthly rent actually changed.
    if (updates.monthly_rent !== undefined && Number(updates.monthly_rent) !== Number(current.monthly_rent)) {
      const { error: archiveError } = await supabaseAdminEngine
        .from('rent_revision_archives')
        .insert([
          {
            tenant_id: tenantId,
            property_id: current.property_id,
            tenant_name: updated.name,
            old_rent: current.monthly_rent,
            new_rent: updates.monthly_rent,
            changed_by: ownerId,
          },
        ]);
      if (archiveError) console.error('Rent revision archive warning:', archiveError.message);
    }

    // 4. Keep the vacancy flags in step with the move: free the unit they left, occupy
    // the one they entered. Both are scoped to this owner.
    if (updates.property_id !== undefined) {
      if (propertyBeingLeft) {
        const { error: freeError } = await supabaseAdminEngine
          .from('properties')
          .update({ is_vacant: true })
          .eq('id', propertyBeingLeft)
          .eq('owner_id', ownerId);
        if (freeError) console.error('Vacancy flag warning (vacated unit):', freeError.message);
      }
      if (updates.property_id) {
        const { error: occupyError } = await supabaseAdminEngine
          .from('properties')
          .update({ is_vacant: false })
          .eq('id', updates.property_id)
          .eq('owner_id', ownerId);
        if (occupyError) console.error('Vacancy flag warning (occupied unit):', occupyError.message);
      }
    }

    return NextResponse.json({ success: true, data: updated }, { status: 200 });

  } catch (runtimeExceptionCatch: any) {
    console.error('Fatal Pipeline Execution Tenant PATCH Route Crash:', runtimeExceptionCatch);
    return NextResponse.json({ error: runtimeExceptionCatch.message || 'Fatal Server Logic Exception.' }, { status: 500 });
  }
}
