import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { supabaseAdminEngine } from '../../../../../lib/supabase-server';
import { isTenantLoginBlocked, TENANT_BLOCKED_MESSAGE } from '../../../../../lib/tenant-access';

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
        properties:property_id ( id, name, address, flat_no, is_vacant, owner_id, owner_phone )
      `)
      .eq('id', tenantId)
      .single();

    if (tenantError) {
      console.error('Supabase Tenant Self-Profile Fetch Error:', tenantError);
      return NextResponse.json({ error: tenantError.message }, { status: 500 });
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
            email: pick(u.email),
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
          owner_phone: propertyNode.owner_phone,
        }
      : null;

    return NextResponse.json({ success: true, data: { tenant, property, owner } }, { status: 200 });

  } catch (runtimeExceptionCatch: any) {
    console.error('Fatal Pipeline Execution Tenant Self-Profile Route Crash:', runtimeExceptionCatch);
    return NextResponse.json({ error: runtimeExceptionCatch.message || 'Fatal Server Logic Exception.' }, { status: 500 });
  }
}
