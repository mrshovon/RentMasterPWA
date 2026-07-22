import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { supabaseAdminEngine } from '@/lib/supabase-server';
import { assertOwnerCanWrite } from '@/lib/subscription';
import { assertFeature } from '@/lib/features';
import { ownerId, STAFF_SELECT, staffFieldsFrom, resolvePropertyId, ownsStaff } from '@/lib/staff';

// =====================================================================================
// 👷 STAFF — SINGLE RECORD (OWNER)
// GET    -> one staff member + their payment history (newest first)
// PATCH  -> edit details / assign-unassign a property / activate-deactivate
// DELETE -> remove the record (staff_payments cascade with it)
//
// Every handler re-scopes by owner_id, so an id belonging to another owner reads as "not
// found" rather than leaking or mutating their row.
// =====================================================================================

// A fresh response each time — a NextResponse body can only be consumed once, so this must
// never be hoisted to a module-level constant shared between requests.
const notFound = () =>
  NextResponse.json({ success: false, error: 'Staff member not found.' }, { status: 404 });

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const uid = ownerId(request);
    if (!uid) return NextResponse.json({ error: 'Context matching identity missing.' }, { status: 400 });

    const gate = await assertFeature(request.headers.get('x-rentmaster-role'), uid, 'staff');
    if (!gate.ok) return NextResponse.json(gate.body, { status: gate.status });

    const { data: row } = await supabaseAdminEngine
      .from('staff')
      .select(STAFF_SELECT)
      .eq('id', id)
      .eq('owner_id', uid)
      .maybeSingle();
    if (!row) return notFound();

    const { data: payments } = await supabaseAdminEngine
      .from('staff_payments')
      .select('*')
      .eq('staff_id', id)
      .eq('owner_id', uid)
      .order('paid_on', { ascending: false });

    return NextResponse.json({ success: true, data: row, payments: payments || [] }, { status: 200 });
  } catch (err: any) {
    console.error('[staff/:id] GET error:', err);
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const uid = ownerId(request);
    if (!uid) return NextResponse.json({ error: 'Context matching identity missing.' }, { status: 400 });

    const role = request.headers.get('x-rentmaster-role');

    const guard = await assertOwnerCanWrite(role, uid);
    if (!guard.ok) return NextResponse.json(guard.body, { status: guard.status });

    const gate = await assertFeature(role, uid, 'staff');
    if (!gate.ok) return NextResponse.json(gate.body, { status: gate.status });

    if (!(await ownsStaff(id, uid))) return notFound();

    const body = await request.json();
    const fields = staffFieldsFrom(body);
    if ('name' in fields && !fields.name) {
      return NextResponse.json({ success: false, error: 'A name is required.' }, { status: 400 });
    }

    let propertyId: string | null | undefined;
    try {
      propertyId = await resolvePropertyId(body, uid);
    } catch (e: any) {
      return NextResponse.json({ success: false, error: e.message }, { status: 400 });
    }
    if (propertyId !== undefined) fields.property_id = propertyId;

    if (Object.keys(fields).length === 0) {
      return NextResponse.json({ success: false, error: 'Nothing to update.' }, { status: 400 });
    }
    fields.updated_at = new Date().toISOString();

    const { data: row, error } = await supabaseAdminEngine
      .from('staff')
      .update(fields)
      .eq('id', id)
      .eq('owner_id', uid)
      .select(STAFF_SELECT)
      .single();
    if (error) throw error;

    return NextResponse.json({ success: true, data: row }, { status: 200 });
  } catch (err: any) {
    console.error('[staff/:id] PATCH error:', err);
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const uid = ownerId(request);
    if (!uid) return NextResponse.json({ error: 'Context matching identity missing.' }, { status: 400 });

    const role = request.headers.get('x-rentmaster-role');

    const guard = await assertOwnerCanWrite(role, uid);
    if (!guard.ok) return NextResponse.json(guard.body, { status: guard.status });

    const gate = await assertFeature(role, uid, 'staff');
    if (!gate.ok) return NextResponse.json(gate.body, { status: gate.status });

    if (!(await ownsStaff(id, uid))) return notFound();

    // staff_payments rows go with it (on delete cascade — see ADD_STAFF.sql).
    const { error } = await supabaseAdminEngine
      .from('staff')
      .delete()
      .eq('id', id)
      .eq('owner_id', uid);
    if (error) throw error;

    return NextResponse.json({ success: true, message: 'Staff member removed.' }, { status: 200 });
  } catch (err: any) {
    console.error('[staff/:id] DELETE error:', err);
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}
