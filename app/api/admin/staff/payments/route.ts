import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { supabaseAdminEngine } from '@/lib/supabase-server';
import { assertOwnerCanWrite } from '@/lib/subscription';
import { assertFeature } from '@/lib/features';
import { ownerId, ownsStaff, PAYMENT_METHODS } from '@/lib/staff';
import { bookAutoTransaction } from '@/lib/accounts';
import crypto from 'crypto';

// =====================================================================================
// 💵 STAFF SALARY PAYMENTS — OWNER
// GET  -> the owner's payment log (newest first). Optional ?staffId= to scope to one person.
// POST -> log a payment against a staff member.
//
// Deliberately an AD-HOC LOG, not a payroll cycle: there is no month to generate or
// reconcile, just "I paid this person this much on this date".
// =====================================================================================

const PAYMENT_SELECT = '*, staff:staff_id ( id, name, designation )';

export async function GET(request: NextRequest) {
  try {
    const uid = ownerId(request);
    if (!uid) return NextResponse.json({ error: 'Context matching identity missing.' }, { status: 400 });

    const gate = await assertFeature(request.headers.get('x-rentmaster-role'), uid, 'staff');
    if (!gate.ok) return NextResponse.json(gate.body, { status: gate.status });

    const staffId = request.nextUrl.searchParams.get('staffId');

    let query = supabaseAdminEngine
      .from('staff_payments')
      .select(PAYMENT_SELECT)
      .eq('owner_id', uid)
      .order('paid_on', { ascending: false });
    if (staffId) query = query.eq('staff_id', staffId);

    const { data, error } = await query;
    if (error) throw error;

    return NextResponse.json({ success: true, count: data?.length || 0, data: data || [] }, { status: 200 });
  } catch (err: any) {
    console.error('[staff/payments] GET error:', err);
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
    const staffId = String(body.staffId || '').trim();
    const amount = Number(body.amount);
    const paidOn = String(body.paidOn || '').slice(0, 10);
    const method = PAYMENT_METHODS.includes(body.method) ? body.method : 'cash';
    const note = String(body.note ?? '').trim() || null;

    if (!staffId) {
      return NextResponse.json({ success: false, error: 'A staff member is required.' }, { status: 400 });
    }
    if (!Number.isFinite(amount) || amount <= 0) {
      return NextResponse.json({ success: false, error: 'Enter an amount greater than zero.' }, { status: 400 });
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(paidOn)) {
      return NextResponse.json({ success: false, error: 'A valid payment date is required.' }, { status: 400 });
    }
    // The staff member must be this owner's — never trust an id from the body.
    if (!(await ownsStaff(staffId, uid))) {
      return NextResponse.json({ success: false, error: 'Staff member not found.' }, { status: 404 });
    }

    const { data: row, error: insertError } = await supabaseAdminEngine
      .from('staff_payments')
      .insert([{
        id: crypto.randomUUID(),
        staff_id: staffId,
        owner_id: uid,
        amount,
        paid_on: paidOn,
        method,
        note,
      }])
      .select(PAYMENT_SELECT)
      .single();

    if (insertError) {
      console.error('[staff/payments] insert failed:', insertError);
      return NextResponse.json({ success: false, error: insertError.message }, { status: 500 });
    }

    // Accounts automation (best-effort): book this salary as an expense against the owner's default
    // account, tagged to the staff member's property. No-op without the Accounts add-on / a default
    // account. Never let a bookkeeping side-effect fail the payment that already succeeded.
    try {
      const { data: staffRow } = await supabaseAdminEngine
        .from('staff')
        .select('property_id')
        .eq('id', staffId)
        .eq('owner_id', uid)
        .maybeSingle();
      await bookAutoTransaction(uid, {
        direction: 'expense',
        amount,
        propertyId: staffRow?.property_id ?? null,
        category: 'Salary',
        txnDate: paidOn,
        source: 'staff_salary',
        sourceRef: row.id,
      });
    } catch (acctErr) {
      console.error('[staff/payments] accounts automation failed (non-fatal):', acctErr);
    }

    return NextResponse.json({ success: true, data: row }, { status: 201 });
  } catch (err: any) {
    console.error('[staff/payments] POST crash:', err);
    return NextResponse.json({ success: false, error: err.message || 'Fatal Server Logic Exception.' }, { status: 500 });
  }
}
