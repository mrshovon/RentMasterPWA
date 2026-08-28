import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { supabaseAdminEngine } from '../../../../../lib/supabase-server';
import { isTenantLoginBlocked, TENANT_BLOCKED_MESSAGE } from '../../../../../lib/tenant-access';
import { apiError } from '@/lib/api-response';
import { isSystemLogin } from '@/lib/validate';

// =====================================================================================
// 🚀 TENANT SELF-PROFILE ENGINE: returns the signed-in tenant's own record joined with
// their property and owner contact details (owners live in Supabase auth user_metadata).
// =====================================================================================
export async function GET(request: NextRequest) {
  try {
    const tenantId = request.headers.get('x-rentmaster-tenant-id');
    if (!tenantId) {
      return NextResponse.json({ error: 'Tenant identity signature missing from request context.' }, { status: 400 });
    }

    // 1. Tenant record + property relation (never expose password/nid hashes)
    const { data: tenantRow, error: tenantError } = await supabaseAdminEngine
      .from('tenants')
      .select(`
        id, name, phone, family_members, monthly_rent, due_date, rented_date, service_charge, advance_amount, property_id,
        allow_login_unassigned,
        properties:property_id ( id, name, address, flat_no, is_vacant, is_self_occupied, owner_id, owner_phone, receipt_name )
      `)
      .eq('id', tenantId)
      .single();

    if (tenantError) {
      return apiError(request, tenantError);
    }

    // Eviction path: tenant JWTs last 7 days and carry no revocation, so blocking login alone
    // would leave an already-signed-in tenant with a week of access. The dashboard calls this on
    // mount, so failing here logs them out on their next load — with no per-request DB cost.
    if (isTenantLoginBlocked(tenantRow as any)) {
      return NextResponse.json(
        { error: TENANT_BLOCKED_MESSAGE, code: 'LOGIN_BLOCKED' },
        { status: 403 }
      );
    }

    const propertyNode = (tenantRow as any).properties || null;

    // 2. Resolve owner contact from the Supabase auth user metadata (fallback to property.owner_phone)
    // Treats null/undefined/blank strings as "missing" and returns the first real value.
    const pick = (...vals: (string | null | undefined)[]) =>
      vals.find((v) => v != null && String(v).trim() !== '') ?? null;

    let owner: { name: string | null; phone: string | null; email: string | null; signature_url: string | null } | null = null;
    const ownerId: string | undefined = propertyNode?.owner_id;
    if (ownerId) {
      try {
        const { data: authRes } = await supabaseAdminEngine.auth.admin.getUserById(ownerId);
        const u = authRes?.user;
        if (u) {
          const meta = (u.user_metadata as any) || {};
          owner = {
            name: pick(meta.name, meta.full_name),
            phone: pick(meta.phone, u.phone, propertyNode?.owner_phone),
            // A system login identifier is an internal credential, not a way to reach the
            // landlord. Handing one to a tenant would put it in a JSON response a third party
            // reads, for no benefit — nothing renders it, and it is not a mailbox.
            email: isSystemLogin(u.email) ? null : pick(u.email),
            signature_url: pick(meta.signature_url),
          };
        }
      } catch (ownerLookupError) {
        console.error('Owner auth lookup warning:', ownerLookupError);
      }
    }
    if (!owner && propertyNode?.owner_phone) {
      owner = { name: null, phone: propertyNode.owner_phone, email: null, signature_url: null };
    }

    // 3. Shape clean payload (drop owner_id from the property we return to the tenant)
    const { properties: _drop, ...tenant } = tenantRow as any;
    const property = propertyNode
      ? {
          id: propertyNode.id,
          name: propertyNode.name,
          address: propertyNode.address,
          flat_no: propertyNode.flat_no,
          is_vacant: propertyNode.is_vacant,
          is_self_occupied: propertyNode.is_self_occupied ?? false,
          owner_phone: propertyNode.owner_phone,
          // The name to print on this property's receipts; null falls back to the owner's name.
          receipt_name: propertyNode.receipt_name ?? null,
        }
      : null;

    return NextResponse.json({ success: true, data: { tenant, property, owner } }, { status: 200 });

  } catch (runtimeExceptionCatch) {
    return apiError(request, runtimeExceptionCatch);
  }
}

// =====================================================================================
// ✏️ TENANT SELF-EDIT — the signed-in tenant updates their own details.
// PATCH { name?, familyMembers? }
//
// STRICT ALLOWLIST, and it must stay that way. This is the only tenant-writable path into the
// tenants table, so it is exactly where the owner-controlled terms would leak if the body were
// spread onto the update. Everything else is refused by construction, not by validation:
//   * phone          — the tenant's LOGIN identity (login matches phone + passcode, and expects
//                      a single row). Owner-managed on purpose; a self-service change could
//                      collide with another tenant and lock both of them out.
//   * monthly_rent, service_charge, advance_amount, due_date, rented_date — financial terms
//                      set by the owner; a tenant editing their own rent is the obvious abuse.
//   * property_id, owner_id, allow_login_unassigned — tenancy/access wiring.
//   * password_hash, nid_hash — credentials.
// =====================================================================================
const MAX_TENANT_NAME_LEN = 120;

export async function PATCH(request: NextRequest) {
  try {
    const tenantId = request.headers.get('x-rentmaster-tenant-id');
    if (!tenantId) {
      return NextResponse.json({ error: 'Tenant identity signature missing from request context.' }, { status: 400 });
    }

    // Same eviction gate as the GET: a tenant whose access was revoked must not be able to write.
    const { data: existing, error: readError } = await supabaseAdminEngine
      .from('tenants')
      .select('id, property_id, allow_login_unassigned')
      .eq('id', tenantId)
      .single();
    if (readError) {
      return apiError(request, readError);
    }
    if (isTenantLoginBlocked(existing as any)) {
      return NextResponse.json({ error: TENANT_BLOCKED_MESSAGE, code: 'LOGIN_BLOCKED' }, { status: 403 });
    }

    const body = await request.json();
    const updates: Record<string, any> = {};

    if (typeof body.name === 'string') {
      const name = body.name.trim().slice(0, MAX_TENANT_NAME_LEN);
      if (!name) return NextResponse.json({ error: 'Name cannot be empty.' }, { status: 400 });
      updates.name = name;
    }

    if (body.familyMembers !== undefined && body.familyMembers !== null && body.familyMembers !== '') {
      const members = Number(body.familyMembers);
      if (!Number.isInteger(members) || members < 0 || members > 99) {
        return NextResponse.json({ error: 'Family members must be a whole number between 0 and 99.' }, { status: 400 });
      }
      updates.family_members = members;
    }

    if (Object.keys(updates).length === 0) {
      return NextResponse.json({ error: 'Provide a name and/or family members to update.' }, { status: 400 });
    }

    const { data: updatedTenant, error: updateError } = await supabaseAdminEngine
      .from('tenants')
      .update(updates)
      .eq('id', tenantId)
      .select('id, name, phone, family_members')
      .single();
    if (updateError) {
      return apiError(request, updateError);
    }

    return NextResponse.json({ success: true, data: updatedTenant }, { status: 200 });
  } catch (runtimeExceptionCatch) {
    return apiError(request, runtimeExceptionCatch);
  }
}
