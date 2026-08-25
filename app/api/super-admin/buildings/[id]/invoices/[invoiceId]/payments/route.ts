import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import crypto from 'crypto';
import { supabaseAdminEngine } from '@/lib/supabase-server';
import { apiError } from '@/lib/api-response';
import { notifyOwner } from '@/lib/notify';
import {
  BUILDING_PLAN_METHODS,
  ownedPlanInvoice,
  recalcPlanInvoice,
  activateBuildingTerm,
  planBalanceOf,
} from '@/lib/building-plan';

// =====================================================================================
// 👑 SUPER ADMIN — RECORD A PLAN PAYMENT
// POST -> money we collected (cash, bank, bKash, a payment link settlement) against an invoice.
//
// This is the only thing that moves a building's term forward. The ladder:
//   payment row inserted -> recalcPlanInvoice() re-derives amount_paid/payment_status
//   -> when the invoice reaches 'paid', activateBuildingTerm() extends the contract.
//
// Order matters and is the same one the owner payment-approval route uses: the money is recorded
// first, the term follows from it. A term that moved before the payment landed would be a
// contract we cannot evidence.
//
// A PARTIAL payment deliberately does NOT extend anything. Half a year's fee is not half a year.
// =====================================================================================

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; invoiceId: string }> }
) {
  try {
    const { id: buildingId, invoiceId } = await params;
    const body = await request.json();

    const invoice: any = await ownedPlanInvoice(invoiceId, buildingId);
    if (!invoice) {
      return NextResponse.json({ success: false, error: 'Invoice not found.' }, { status: 404 });
    }
    if (invoice.status === 'void') {
      return NextResponse.json(
        { success: false, error: 'This invoice is void. Raise a new one before recording money against it.' },
        { status: 409 }
      );
    }

    const amount = Number(body.amount);
    if (!Number.isFinite(amount) || amount <= 0) {
      return NextResponse.json({ success: false, error: 'Enter an amount greater than zero.' }, { status: 400 });
    }

    const paidOn = String(body.paidOn || '').slice(0, 10);
    if (!DATE_RE.test(paidOn)) {
      return NextResponse.json({ success: false, error: 'A valid payment date is required.' }, { status: 400 });
    }

    const method = (BUILDING_PLAN_METHODS as readonly string[]).includes(body.method)
      ? String(body.method)
      : 'bank';

    const { data: payment, error } = await supabaseAdminEngine
      .from('building_plan_payments')
      .insert([{
        id: crypto.randomUUID(),
        invoice_id: invoiceId,
        building_id: buildingId,
        admin_id: invoice.admin_id,
        amount,
        paid_on: paidOn,
        method,
        reference: String(body.reference ?? '').trim().slice(0, 120) || null,
        // Null when this came from accepting the building's own claim — that is what
        // distinguishes "we collected this" from "they told us they paid".
        recorded_by: body.fromClaim ? null : request.headers.get('x-rentmaster-uid'),
        note: String(body.note ?? '').trim().slice(0, 2000) || null,
      }])
      .select('*')
      .single();
    if (error) throw error;

    const updated: any = await recalcPlanInvoice(invoiceId);

    let subscription: any = null;
    if (updated?.payment_status === 'paid') {
      // startOn is honoured for a back-dated deal; otherwise activateBuildingTerm() runs
      // max(today, current expiry), so renewing early ADDS to the remaining term.
      subscription = await activateBuildingTerm(buildingId, {
        months: Number(updated.term_months || invoice.term_months || 12),
        startOn: DATE_RE.test(String(invoice.period_start || '').slice(0, 10))
          ? String(invoice.period_start).slice(0, 10)
          : null,
      });
    }

    void notifyOwner({
      userId: invoice.admin_id,
      title: updated?.payment_status === 'paid' ? 'Payment received — plan renewed' : 'Payment recorded',
      body:
        updated?.payment_status === 'paid'
          ? `৳${amount} received. Your plan now runs to ${subscription?.expiry_date || 'the new expiry date'}.`
          : `৳${amount} received. ৳${planBalanceOf(updated)} still outstanding.`,
      url: '/building#plan',
      tag: `building-plan-payment-${invoiceId}`,
    });

    return NextResponse.json(
      { success: true, data: { payment, invoice: updated, subscription } },
      { status: 201 }
    );
  } catch (err) {
    return apiError(request, err);
  }
}
