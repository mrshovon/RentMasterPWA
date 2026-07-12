import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { supabaseAdminEngine } from '../../../../lib/supabase-server';
import { resolveOwnerSubscription, assertOwnerCanWrite, checkCreateLimit, assertItemEnabled } from '../../../../lib/subscription';
import { generatePasscode, hashPasscode } from '../../../../lib/passcode';
import crypto from 'crypto';


// =========================================================
// 📥 1. FETCH ALL TENANTS ASSOCIATED TO PROPERTIES (GET)
// =========================================================
export async function GET(request: NextRequest) {
  try {
    const ownerId = request.headers.get('x-rentmaster-uid');
    if (!ownerId || ownerId === 'YOUR_ACTUAL_USER_UUID_FROM_DATABASE') {
      return NextResponse.json({ error: 'Context matching identity extraction missing.' }, { status: 400 });
    }

    // Relational schema dynamic lookup matching: Pull only tenants linked to properties owned by this owner
    const { data: tenantsList, error: fetchError } = await supabaseAdminEngine
      .from('tenants')
      .select(`
        *,
        properties!inner (
          id,
          name,
          owner_id
        )
      `)
      .eq('properties.owner_id', ownerId);

    if (fetchError) {
      console.error('Supabase Tenants Fetch Error:', fetchError);
      return NextResponse.json({ error: fetchError.message }, { status: 500 });
    }

    return NextResponse.json({ success: true, count: tenantsList.length, data: tenantsList }, { status: 200 });

  } catch (runtimeExceptionCatch: any) {
    console.error('Pipeline Execution Tenants GET Critical Route Crash:', runtimeExceptionCatch);
    return NextResponse.json({ error: runtimeExceptionCatch.message || 'Fatal Server Logic Exception.' }, { status: 500 });
  }
}


// =========================================================
// 🚀 FIXED: Tenant Registration & Auto Property Linkage Pipeline
// =========================================================
export async function POST(request: NextRequest) {
  try {
    const ownerId = request.headers.get('x-rentmaster-uid');
    if (!ownerId || ownerId === 'YOUR_ACTUAL_USER_UUID_FROM_DATABASE') {
      return NextResponse.json({ error: 'Context matching identity extraction missing.' }, { status: 400 });
    }

    const role = request.headers.get('x-rentmaster-role');

    const bodyPayload = await request.json();
    const { propertyId, name, phone, familyMembers, nid, monthlyRent, dueDate,rentedDate,serviceCharge,advanceAmount } = bodyPayload;

    // 1. Structural Column Parameter Validation check
    if (!propertyId || !name || !phone || !monthlyRent || !dueDate) {
      return NextResponse.json({ error: 'Validation missing compulsory database column parameters.' }, { status: 400 });
    }

    // Subscription gate: block if the owner's plan is locked, then enforce the tier limit.
    const guard = await assertOwnerCanWrite(role, ownerId);
    if (!guard.ok) return NextResponse.json(guard.body, { status: guard.status });

    if (role === 'owner') {
      const sub = await resolveOwnerSubscription(ownerId);
      // Can't onboard into a disabled (over-limit) unit.
      const itemGuard = await assertItemEnabled(role, ownerId, sub, { propertyId });
      if (!itemGuard.ok) return NextResponse.json(itemGuard.body, { status: itemGuard.status });

      const limitCheck = await checkCreateLimit('tenant', ownerId, sub);
      if (!limitCheck.allowed) {
        return NextResponse.json({
          error: `You've reached your ${sub.tierName} limit of ${limitCheck.limit} tenant${limitCheck.limit === 1 ? '' : 's'}. Upgrade your plan to add more.`,
          code: 'LIMIT_REACHED',
          current: limitCheck.current,
          limit: limitCheck.limit,
        }, { status: 403 });
      }
    }
    const tenantId = crypto.randomUUID();
    const rawPasscode = generatePasscode();
    const dummyPasswordHash = hashPasscode(rawPasscode);
    const nidHash = nid ? crypto.createHash('sha256').update(String(nid)).digest('hex') : null;
    // 2. Register operational metrics target inside public.tenants table schema
    const { data: tenantRecord, error: tenantInsertError } = await supabaseAdminEngine
      .from('tenants')
      .insert([
        {
          id: tenantId,
          property_id: propertyId,
          name: name,
          phone: phone,
          family_members: familyMembers || 1,
          nid_hash: nidHash || null,
          password_hash: dummyPasswordHash || null,
          monthly_rent: parseFloat(monthlyRent),
          due_date: parseInt(dueDate),
          rented_date:rentedDate || null,
          service_charge:serviceCharge || 0.00,
          advance_amount:advanceAmount || 0.00
        }
      ])
      .select()
      .single();

    if (tenantInsertError) {
      console.error('Supabase Tenant Write Error:', tenantInsertError);
      return NextResponse.json({ error: tenantInsertError.message }, { status: 500 });
    }

    // 3. Side-Effect Automation Layer: Toggle unit state 'is_vacant' to false inside public.properties
    const { error: propertyUpdateError } = await supabaseAdminEngine
      .from('properties')
      .update({ is_vacant: false })
      .eq('id', propertyId)
      .eq('owner_id', ownerId);

    if (propertyUpdateError) {
      console.error('Automation side effect update warning error:', propertyUpdateError);
      // We still return success since tenant record exists but notify pipeline warnings
      return NextResponse.json({ success: true, data: tenantRecord, passcode: rawPasscode, warning: 'Tenant linked, but property state toggle exception.' }, { status: 201 });
    }

    // `passcode` is the one-time plaintext for the owner to share; it is not stored.
    return NextResponse.json({ success: true, data: tenantRecord, passcode: rawPasscode }, { status: 201 });

  } catch (runtimeExceptionCatch: any) {
    console.error('Fatal Pipeline Execution Tenant Core Route Crash:', runtimeExceptionCatch);
    return NextResponse.json({ error: runtimeExceptionCatch.message || 'Fatal Server Logic Exception.' }, { status: 500 });
  }
}