import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { supabaseAdminEngine } from '@/lib/supabase-server';
import { apiError } from '@/lib/api-response';
import { ownedPlanInvoice, recalcPlanInvoice } from '@/lib/building-plan';

// =====================================================================================
// 👑 SUPER ADMIN — REVERSE A PLAN PAYMENT
// DELETE -> a mis-keyed amount, a bounced transfer, a payment entered against the wrong building.
//
// Deleting the row and re-deriving is the whole correction: recalcPlanInvoice() walks
// amount_paid, payment_status and the invoice status back down, exactly as adding one walked
// them up. The building's contract dates are deliberately NOT rewound — a term already granted
// and communicated is a commercial decision to unwind by hand from the contract form, not a side
// effect of a bookkeeping fix. The admin sees the invoice reopen and can adjust the dates
// themselves if that is really what they mean.
// =====================================================================================

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; invoiceId: string; paymentId: string }> }
) {
  try {
    const { id: buildingId, invoiceId, paymentId } = await params;

    const invoice = await ownedPlanInvoice(invoiceId, buildingId);
    if (!invoice) {
      return NextResponse.json({ success: false, error: 'Invoice not found.' }, { status: 404 });
    }

    // Scoped to the invoice as well as the id, so a guessed payment id from another building
    // reads as "not found" rather than being deletable by whoever guessed it.
    const { data: existing } = await supabaseAdminEngine
      .from('building_plan_payments')
      .select('id')
      .eq('id', paymentId)
      .eq('invoice_id', invoiceId)
      .maybeSingle();
    if (!existing) {
      return NextResponse.json({ success: false, error: 'Payment not found.' }, { status: 404 });
    }

    const { error } = await supabaseAdminEngine
      .from('building_plan_payments')
      .delete()
      .eq('id', paymentId);
    if (error) throw error;

    const updated = await recalcPlanInvoice(invoiceId);

    return NextResponse.json({ success: true, data: { invoice: updated } }, { status: 200 });
  } catch (err) {
    return apiError(request, err);
  }
}
