import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { supabaseAdminEngine } from '@/lib/supabase-server';
import { assertOwnerCanWrite } from '@/lib/subscription';
import { bookAutoTransaction } from '@/lib/accounts';
import { sendPushToUsers } from '@/lib/push-send';
import { apiError } from '@/lib/api-response';
import { requireBuildingAdmin } from '@/lib/building';
import {
  ownedBuildingInvoice,
  recalcBuildingInvoice,
  balanceOf,
  BUILDING_PAYMENT_METHODS,
  SETTLED_BUILDING_INVOICE_ERROR,
} from '@/lib/building-billing';

// =====================================================================================
// 🏢 BUILDING ADMIN — RECORD MONEY AGAINST A SERVICE CHARGE INVOICE
// GET  -> the payments on one invoice.
// POST -> record one. The row is the truth; the invoice's figures are re-derived from it.
//
// Recording a payment also books an INCOME row into the building's default account. That is
// best-effort and feature-gated (bookAutoTransaction no-ops when Accounts is off or no default
// account exists), so the money is never lost just because the bookkeeping module is not set up.
// =====================================================================================

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;

    const gate = await requireBuildingAdmin(request);
    if (!gate.ok) return NextResponse.json(gate.body, { status: gate.status });

    if (!(await ownedBuildingInvoice(id, gate.building!.id))) {
      return NextResponse.json({ success: false, error: 'Invoice not found.' }, { status: 404 });
    }

    const { data, error } = await supabaseAdminEngine
      .from('building_service_payments')
      .select('*')
      .eq('invoice_id', id)
      .order('paid_on', { ascending: true });
    if (error) throw error;

    return NextResponse.json({ success: true, count: data?.length || 0, data: data || [] }, { status: 200 });
  } catch (err) {
    return apiError(request, err);
  }
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;

    const gate = await requireBuildingAdmin(request);
    if (!gate.ok) return NextResponse.json(gate.body, { status: gate.status });

    const guard = await assertOwnerCanWrite(request.headers.get('x-rentmaster-role'), gate.uid!);
    if (!guard.ok) return NextResponse.json(guard.body, { status: guard.status });

    const invoice = await ownedBuildingInvoice(id, gate.building!.id);
    if (!invoice) {
      return NextResponse.json({ success: false, error: 'Invoice not found.' }, { status: 404 });
    }
    if (invoice.payment_status === 'paid') {
      return NextResponse.json(
        { success: false, error: SETTLED_BUILDING_INVOICE_ERROR, code: 'SETTLED_INVOICE' },
        { status: 409 }
      );
    }

    const body = await request.json();

    // No amount named means "settle it" — the common case, and the one where retyping the
    // outstanding figure by hand is exactly how a rounding error gets in.
    const amount = body.amount === undefined || body.amount === '' || body.amount === null
      ? balanceOf(invoice)
      : Number(body.amount);
    if (!Number.isFinite(amount) || amount <= 0) {
      return NextResponse.json(
        { success: false, error: 'Enter an amount greater than zero.' },
        { status: 400 }
      );
    }

    const method = String(body.method || 'cash');
    if (!BUILDING_PAYMENT_METHODS.includes(method as any)) {
      return NextResponse.json({ success: false, error: 'Unknown payment method.' }, { status: 400 });
    }

    const paidOn = /^\d{4}-\d{2}-\d{2}$/.test(String(body.paidOn || ''))
      ? String(body.paidOn)
      : new Date().toISOString().slice(0, 10);

    const { data: payment, error: insertErr } = await supabaseAdminEngine
      .from('building_service_payments')
      .insert({
        id: crypto.randomUUID(),
        invoice_id: id,
        building_id: gate.building!.id,
        owner_id: invoice.owner_id,
        amount,
        paid_on: paidOn,
        method,
        note: body.note ? String(body.note).trim().slice(0, 500) : null,
      })
      .select('*')
      .single();
    if (insertErr) throw insertErr;

    const refreshed = await recalcBuildingInvoice(id);

    // Income into the building's books. source is 'billing' rather than a new value so the
    // account_transactions CHECK constraint stays untouched; source_ref is the PAYMENT id, which
    // is a fresh uuid and so can never collide with a rent ledger's.
    try {
      await bookAutoTransaction(gate.uid!, {
        direction: 'income',
        amount,
        propertyId: null,
        category: 'Service charge',
        txnDate: paidOn,
        source: 'billing',
        sourceRef: String(payment.id),
      });
    } catch (bookErr) {
      console.error('[building-billing] bookAutoTransaction failed (non-fatal):', bookErr);
    }

    // Tell the owner their payment was recorded, so a receipt is never the first they hear of it.
    try {
      await sendPushToUsers([String(invoice.owner_id)], {
        title: refreshed?.payment_status === 'paid' ? 'Service charge settled' : 'Payment recorded',
        body: `৳${amount} received for ${invoice.billing_month}.`,
        url: '/owner#service-charge',
        tag: `building-payment-${id}`,
      });
    } catch (pushErr) {
      console.error('[building-billing] push dispatch failed (non-fatal):', pushErr);
    }

    return NextResponse.json({ success: true, data: { payment, invoice: refreshed } }, { status: 201 });
  } catch (err) {
    return apiError(request, err);
  }
}
