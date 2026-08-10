import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { supabaseAdminEngine } from '@/lib/supabase-server';
import { assertOwnerCanWrite } from '@/lib/subscription';
import { assertFeature } from '@/lib/features';
import { ownerId } from '@/lib/staff';
import { reverseAutoTransaction } from '@/lib/accounts';
import { apiError } from '@/lib/api-response';

// =====================================================================================
// 💵 STAFF SALARY PAYMENT — DELETE (OWNER)
// Removes a mis-entered payment. Scoped by owner_id so one owner can never delete another's.
// =====================================================================================

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ paymentId: string }> }) {
  try {
    const { paymentId } = await params;
    const uid = ownerId(request);
    if (!uid) return NextResponse.json({ error: 'Context matching identity missing.' }, { status: 400 });

    const role = request.headers.get('x-rentmaster-role');

    const guard = await assertOwnerCanWrite(role, uid);
    if (!guard.ok) return NextResponse.json(guard.body, { status: guard.status });

    const gate = await assertFeature(role, uid, 'staff');
    if (!gate.ok) return NextResponse.json(gate.body, { status: gate.status });

    const { data: existing } = await supabaseAdminEngine
      .from('staff_payments')
      .select('id')
      .eq('id', paymentId)
      .eq('owner_id', uid)
      .maybeSingle();
    if (!existing) {
      return NextResponse.json({ success: false, error: 'Payment not found.' }, { status: 404 });
    }

    const { error } = await supabaseAdminEngine
      .from('staff_payments')
      .delete()
      .eq('id', paymentId)
      .eq('owner_id', uid);
    if (error) throw error;

    // Accounts automation (best-effort): remove the expense this payment auto-booked, if any.
    try {
      await reverseAutoTransaction(uid, 'staff_salary', paymentId);
    } catch (acctErr) {
      console.error('[staff/payments/:id] accounts reversal failed (non-fatal):', acctErr);
    }

    return NextResponse.json({ success: true, message: 'Payment deleted.' }, { status: 200 });
  } catch (err) {
    return apiError(request, err);
  }
}
