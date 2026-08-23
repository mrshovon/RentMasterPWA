import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { supabaseAdminEngine } from '@/lib/supabase-server';
import { assertOwnerCanWrite } from '@/lib/subscription';
import { assertFeature } from '@/lib/features';
import { ownerId, STAFF_SELECT, staffFieldsFrom, resolvePropertyId, shapeStaffForOwner } from '@/lib/staff';
import crypto from 'crypto';
import { apiError } from '@/lib/api-response';

// =====================================================================================
// 👷 STAFF — OWNER
// GET  -> the owner's staff (newest first), with the assigned property's name joined in.
// POST -> add a staff member.
//
// Staff is a paid module: BOTH verbs run assertFeature('staff'). Gating only the writes
// would leave the list readable after an admin switches the add-on off.
// =====================================================================================

export async function GET(request: NextRequest) {
  try {
    const uid = ownerId(request);
    if (!uid) return NextResponse.json({ error: 'Context matching identity missing.' }, { status: 400 });

    const gate = await assertFeature(request.headers.get('x-rentmaster-role'), uid, 'staff');
    if (!gate.ok) return NextResponse.json(gate.body, { status: gate.status });

    const { data, error } = await supabaseAdminEngine
      .from('staff')
      .select(STAFF_SELECT)
      .eq('owner_id', uid)
      .order('created_at', { ascending: false });
    if (error) throw error;

    // NID decrypted for the owner who entered it; the ciphertext column never leaves the server.
    // Shared with the POST/PATCH routes so the responses can never drift — see lib/staff.ts.
    const shaped = (data || []).map(shapeStaffForOwner);

    return NextResponse.json({ success: true, count: shaped.length, data: shaped }, { status: 200 });
  } catch (err) {
    return apiError(request, err);
  }
}

export async function POST(request: NextRequest) {
  try {
    const uid = ownerId(request);
    if (!uid) return NextResponse.json({ error: 'Context matching identity missing.' }, { status: 400 });

    const role = request.headers.get('x-rentmaster-role');

    const guard = await assertOwnerCanWrite(role, uid);
    if (!guard.ok) return NextResponse.json(guard.body, { status: guard.status });

    const gate = await assertFeature(role, uid, 'staff');
    if (!gate.ok) return NextResponse.json(gate.body, { status: gate.status });

    const body = await request.json();
    let fields: Record<string, unknown>;
    try {
      fields = staffFieldsFrom(body);
    } catch (e: any) {
      return NextResponse.json({ success: false, error: e.message }, { status: 400 });
    }
    if (!fields.name) {
      return NextResponse.json({ success: false, error: 'A name is required.' }, { status: 400 });
    }

    let propertyId: string | null | undefined;
    try {
      propertyId = await resolvePropertyId(body, uid);
    } catch (e: any) {
      return NextResponse.json({ success: false, error: e.message }, { status: 400 });
    }

    const { data: row, error: insertError } = await supabaseAdminEngine
      .from('staff')
      .insert([{
        id: crypto.randomUUID(),
        owner_id: uid,
        ...fields,
        property_id: propertyId ?? null,
      }])
      .select(STAFF_SELECT)
      .single();

    if (insertError) {
      return apiError(request, insertError);
    }

    return NextResponse.json({ success: true, data: shapeStaffForOwner(row) }, { status: 201 });
  } catch (err) {
    return apiError(request, err);
  }
}
