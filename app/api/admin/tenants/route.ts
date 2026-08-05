import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { supabaseAdminEngine } from '../../../../lib/supabase-server';
import { resolveOwnerSubscription, assertOwnerCanWrite, checkCreateLimit, assertItemEnabled } from '../../../../lib/subscription';
import { generatePasscode, hashPasscode } from '../../../../lib/passcode';
import { encryptField, hasEncryptionKey } from '../../../../lib/field-crypto';
import { shapeTenantForOwner } from '../../../../lib/tenants';
import { validatePhone } from '../../../../lib/validate';
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

    // Scope on tenants.owner_id (not the property join) so tenants who are currently
    // unassigned — moved out, between flats — still belong to, and are visible to, their
    // owner. The property embed is a left join: `properties` is null when unassigned.
    const { data: tenantsList, error: fetchError } = await supabaseAdminEngine
      .from('tenants')
      .select(`
        *,
        properties:property_id (
          id,
          name,
          owner_id
        )
      `)
      .eq('owner_id', ownerId);

    if (fetchError) {
      console.error('Supabase Tenants Fetch Error:', fetchError);
      return NextResponse.json({ error: fetchError.message }, { status: 500 });
    }

    // NID decrypted so the owner can read and correct what they entered; credential columns
    // stripped (select('*') was shipping password_hash and the legacy nid_hash to the browser).
    // Shared with the PATCH route so the two responses can never drift — see lib/tenants.ts.
    const shaped = (tenantsList || []).map(shapeTenantForOwner);

    return NextResponse.json({ success: true, count: shaped.length, data: shaped }, { status: 200 });

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

    // The phone IS the tenant's login identity, so it is stored canonically. Everything the
    // tenant later types is matched against this via phoneLookupCandidates in the login route.
    const parsedPhone = validatePhone(phone, { required: true });
    if (!parsedPhone.ok) {
      return NextResponse.json({ error: parsedPhone.error }, { status: 400 });
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

    // The NID is ENCRYPTED, not hashed: the owner has to be able to read back what they typed to
    // confirm it or fix a typo. Hashing made it permanently unreadable and so uneditable.
    // A missing key is reported, never swallowed — silently dropping an NID the owner believes
    // they saved is worse than refusing the write.
    const trimmedNid = String(nid ?? '').trim();
    if (trimmedNid && !hasEncryptionKey()) {
      return NextResponse.json({
        error: 'Cannot store the National ID: NID_ENCRYPTION_KEY is not configured on the server.',
      }, { status: 500 });
    }
    const nidEncrypted = trimmedNid ? encryptField(trimmedNid) : null;
    // 2. Register operational metrics target inside public.tenants table schema
    const { data: tenantRecord, error: tenantInsertError } = await supabaseAdminEngine
      .from('tenants')
      .insert([
        {
          id: tenantId,
          property_id: propertyId,
          owner_id: ownerId,
          name: name,
          phone: parsedPhone.value,
          family_members: familyMembers || 1,
          nid_encrypted: nidEncrypted,
          password_hash: dummyPasswordHash || null,
          monthly_rent: parseFloat(monthlyRent),
          due_date: parseInt(dueDate),
          rented_date:rentedDate || null,
          service_charge:serviceCharge || 0.00,
          advance_amount:advanceAmount || 0.00
        }
      ])
      // Same embed as the list GET, so a freshly created tenant is shape-identical to a listed one.
      .select(`
        *,
        properties:property_id (
          id,
          name,
          owner_id
        )
      `)
      .single();

    if (tenantInsertError) {
      console.error('Supabase Tenant Write Error:', tenantInsertError);
      // A schema error must not reach the owner as a bare database sentence — the not-null
      // failure on the legacy nid_hash column reads as "null value in column …", which is
      // meaningless to them. Name the migration instead, keeping the original for diagnosis.
      const raw = tenantInsertError.message || '';
      const isNidSchemaIssue = /nid_hash|nid_encrypted/i.test(raw);
      return NextResponse.json({
        error: isNidSchemaIssue
          ? `The tenants table is out of date — run ADD_TENANT_NID_AND_RECEIPT_NAME.sql in Supabase. (${raw})`
          : raw || 'Could not save the tenant.',
      }, { status: 500 });
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
      return NextResponse.json({ success: true, data: shapeTenantForOwner(tenantRecord), passcode: rawPasscode, warning: 'Tenant linked, but property state toggle exception.' }, { status: 201 });
    }

    // `passcode` is the one-time plaintext for the owner to share; it is not stored.
    // Shaped like the GET and the PATCH: without the decrypted `nid`, the client's copy of this
    // tenant has no NID, and the owner's next edit would send an empty field and erase it.
    return NextResponse.json({ success: true, data: shapeTenantForOwner(tenantRecord), passcode: rawPasscode }, { status: 201 });

  } catch (runtimeExceptionCatch: any) {
    console.error('Fatal Pipeline Execution Tenant Core Route Crash:', runtimeExceptionCatch);
    return NextResponse.json({ error: runtimeExceptionCatch.message || 'Fatal Server Logic Exception.' }, { status: 500 });
  }
}