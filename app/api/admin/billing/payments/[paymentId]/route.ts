import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { supabaseAdminEngine } from '@/lib/supabase-server';
import { assertOwnerCanWrite } from '@/lib/subscription';
import { ownerId, recalcLedger, SETTLED_INVOICE_ERROR } from '@/lib/billing';
import { reverseAutoTransaction } from '@/lib/accounts';
import { apiError } from '@/lib/api-response';

// =====================================================================================
// 🧾 RENT PAYMENT (INSTALLMENT) — DELETE (OWNER)
// Removes a mis-entered payment. Scoped by owner_id so one owner can never delete another's.
// The parent invoice is re-derived afterwards, so deleting the last payment walks the status
// back down the ladder (paid -> partial -> unpaid) on its own.
// =====================================================================================

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ paymentId: string }> }) {
  try {
    const { paymentId } = await params;
    // Checked before the uid test: the middleware injects no uid for a tenant, so this is what
    // gives them a truthful 403 instead of "identity missing".
    if (request.headers.get('x-rentmaster-tenant-id')) {
      return NextResponse.json({ error: 'Only the owner can delete a payment.' }, { status: 403 });
    }

    const uid = ownerId(request);
    if (!uid) return NextResponse.json({ error: 'Context matching identity missing.' }, { status: 400 });

    const role = request.headers.get('x-rentmaster-role');

    const guard = await assertOwnerCanWrite(role, uid);
    if (!guard.ok) return NextResponse.json(guard.body, { status: guard.status });

    const { data: existing } = await supabaseAdminEngine
      .from('billing_payments')
      .select('id, ledger_id')
      .eq('id', paymentId)
      .eq('owner_id', uid)
      .maybeSingle();
    if (!existing) {
      return NextResponse.json({ success: false, error: 'Payment not found.' }, { status: 404 });
    }

    // The freeze rule lives here too, and this is the guard that actually matters: without it,
    // "you can't change a settled invoice" is bypassed by deleting an installment, because the
    // recalc below would walk the status straight back down to partial/unpaid.
    const { data: parentLedger } = await supabaseAdminEngine
      .from('billing_ledgers')
      .select('payment_status')
      .eq('id', existing.ledger_id)
      .eq('created_by_owner', uid)
      .maybeSingle();
    if (parentLedger?.payment_status === 'paid') {
      return NextResponse.json({ success: false, error: SETTLED_INVOICE_ERROR }, { status: 409 });
    }

    const { error } = await supabaseAdminEngine
      .from('billing_payments')
      .delete()
      .eq('id', paymentId)
      .eq('owner_id', uid);
    if (error) throw error;

    // Accounts automation (best-effort): remove the income this installment auto-booked, if any.
    try {
      await reverseAutoTransaction(uid, 'billing', paymentId);
    } catch (acctErr) {
      console.error('[billing/payments/:id] accounts reversal failed (non-fatal):', acctErr);
    }

    const ledger = await recalcLedger(existing.ledger_id);

    return NextResponse.json({ success: true, message: 'Payment deleted.', ledger }, { status: 200 });
  } catch (err) {
    return apiError(request, err);
  }
}
