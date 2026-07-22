import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { supabaseAdminEngine } from '@/lib/supabase-server';
import { assertOwnerCanWrite } from '@/lib/subscription';
import { assertFeature } from '@/lib/features';
import { ownerId } from '@/lib/staff';

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

    return NextResponse.json({ success: true, message: 'Payment deleted.' }, { status: 200 });
  } catch (err: any) {
    console.error('[staff/payments/:id] DELETE error:', err);
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}
