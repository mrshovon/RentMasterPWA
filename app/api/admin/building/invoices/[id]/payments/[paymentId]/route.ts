import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { supabaseAdminEngine } from '@/lib/supabase-server';
import { assertOwnerCanWrite } from '@/lib/subscription';
import { reverseAutoTransaction } from '@/lib/accounts';
import { apiError } from '@/lib/api-response';
import { requireBuildingAdmin } from '@/lib/building';
import { ownedBuildingInvoice, recalcBuildingInvoice } from '@/lib/building-billing';

// =====================================================================================
// 🏢 BUILDING ADMIN — DELETE ONE RECORDED PAYMENT
//
// Undoing money is a three-step sequence and the ORDER matters: reverse the booked income
// first, then delete the payment row, then re-derive the invoice. Deleting the row first would
// leave an income entry in the books pointing at a payment that no longer exists, and nothing
// would ever clean it up.
//
// A settled invoice is NOT frozen against this: walking a mistaken payment back out is exactly
// how a settled-in-error invoice gets fixed. The recalc drops the status back down on its own.
// =====================================================================================

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; paymentId: string }> }
) {
  try {
    const { id, paymentId } = await params;

    const gate = await requireBuildingAdmin(request);
    if (!gate.ok) return NextResponse.json(gate.body, { status: gate.status });

    const guard = await assertOwnerCanWrite(request.headers.get('x-rentmaster-role'), gate.uid!);
    if (!guard.ok) return NextResponse.json(guard.body, { status: guard.status });

    if (!(await ownedBuildingInvoice(id, gate.building!.id))) {
      return NextResponse.json({ success: false, error: 'Invoice not found.' }, { status: 404 });
    }

    const { data: payment } = await supabaseAdminEngine
      .from('building_service_payments')
      .select('id')
      .eq('id', paymentId)
      .eq('invoice_id', id)
      .maybeSingle();
    if (!payment) {
      return NextResponse.json({ success: false, error: 'Payment not found.' }, { status: 404 });
    }

    try {
      await reverseAutoTransaction(gate.uid!, 'billing', String(payment.id));
    } catch (revErr) {
      console.error('[building-billing] reverseAutoTransaction failed (non-fatal):', revErr);
    }

    const { error } = await supabaseAdminEngine
      .from('building_service_payments')
      .delete()
      .eq('id', paymentId)
      .eq('invoice_id', id);
    if (error) throw error;

    const refreshed = await recalcBuildingInvoice(id);

    return NextResponse.json({ success: true, data: refreshed }, { status: 200 });
  } catch (err) {
    return apiError(request, err);
  }
}
