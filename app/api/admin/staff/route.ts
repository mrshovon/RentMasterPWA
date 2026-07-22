import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { supabaseAdminEngine } from '@/lib/supabase-server';
import { assertOwnerCanWrite } from '@/lib/subscription';
import { assertFeature } from '@/lib/features';
import { ownerId, STAFF_SELECT, staffFieldsFrom, resolvePropertyId } from '@/lib/staff';
import crypto from 'crypto';

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

    return NextResponse.json({ success: true, count: data?.length || 0, data: data || [] }, { status: 200 });
  } catch (err: any) {
    console.error('[staff] GET error:', err);
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
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
    const fields = staffFieldsFrom(body);
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
      console.error('[staff] insert failed:', insertError);
      return NextResponse.json({ success: false, error: insertError.message }, { status: 500 });
    }

    return NextResponse.json({ success: true, data: row }, { status: 201 });
  } catch (err: any) {
    console.error('[staff] POST crash:', err);
    return NextResponse.json({ success: false, error: err.message || 'Fatal Server Logic Exception.' }, { status: 500 });
  }
}
