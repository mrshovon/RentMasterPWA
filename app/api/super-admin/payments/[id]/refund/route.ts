import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { supabaseAdminEngine } from '@/lib/supabase-server';
import { apiError } from '@/lib/api-response';
import { shapeSubmission } from '@/lib/payments/submissions';
import { currentCredentials, refundPayment } from '@/lib/payments/uddoktapay';
import { logEvent } from '@/lib/logger';

// =====================================================================================
// REFUND AN ONLINE PAYMENT — SUPER ADMIN ONLY
// POST { reason } -> refund through UddoktaPay and mark the submission 'refunded'.
//
// Admin-only via the /api/super-admin/* gate in middleware.ts.
//
// ⚠️ ONLY UDDOKTAPAY ROWS. A manual_bkash payment arrived in someone's personal wallet and has
// to be sent back by hand — there is no API that can move it, and pretending otherwise by
// flipping the status would produce a row claiming a refund that never happened.
//
// ⭐ REFUNDING DOES NOT REVOKE THE PLAN. Deliberate: the two are different decisions, and doing
// them together would let a mis-clicked refund silently lock an owner out of a working account.
// The admin cancels or reassigns the plan separately (Owners → assign plan), which is also the
// path that already exists and is already audited.
//
// The five fields the endpoint needs — transaction_id, payment_method, amount, product_name,
// reason — were verified against the UddoktaPay Refund API reference (2026-09-10). It does NOT
// take invoice_id, which is why fulfilment stores the transaction id and payment method on the
// row at the time of payment: none of it can be re-derived here.
// =====================================================================================

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id: paymentId } = await params; // params is a Promise in Next 16
    const adminId = request.headers.get('x-rentmaster-uid');

    const body = await request.json();
    const reason = String(body?.reason ?? '').trim();
    if (!reason) {
      return NextResponse.json(
        { success: false, error: 'A reason is required — it is sent to the gateway and kept on the record.' },
        { status: 400 },
      );
    }

    const { data: row, error: readError } = await supabaseAdminEngine
      .from('payment_submissions')
      .select('id, owner_id, tier_id, amount, status, provider, gateway_txn_id, gateway_payment_method')
      .eq('id', paymentId)
      .maybeSingle();
    if (readError) throw readError;
    if (!row) return NextResponse.json({ success: false, error: 'Payment not found.' }, { status: 404 });

    if (row.provider !== 'uddoktapay') {
      return NextResponse.json(
        {
          success: false,
          error: 'This was paid by hand into your wallet, so it has to be refunded the same way. Mark it up in your own records.',
        },
        { status: 400 },
      );
    }
    if (row.status === 'refunded') {
      return NextResponse.json({ success: false, error: 'This payment was already refunded.' }, { status: 409 });
    }
    if (row.status !== 'approved') {
      return NextResponse.json(
        { success: false, error: `Only a completed payment can be refunded — this one is '${row.status}'.` },
        { status: 409 },
      );
    }
    if (!row.gateway_txn_id || !row.gateway_payment_method) {
      return NextResponse.json(
        {
          success: false,
          error: 'This payment has no gateway transaction id on file, so it cannot be refunded through the API. Refund it from the Paymently dashboard.',
        },
        { status: 400 },
      );
    }

    const credentials = await currentCredentials();
    if (!credentials) {
      return NextResponse.json(
        { success: false, error: 'The gateway is not configured, so no refund can be sent.' },
        { status: 400 },
      );
    }

    // The plan name is what the customer sees on their statement, so it is what goes in
    // product_name. Falls back to the slug rather than failing the refund over a display string.
    let productName = String(row.tier_id);
    try {
      const { data: tier } = await supabaseAdminEngine
        .from('subscription_tiers')
        .select('name')
        .eq('id', row.tier_id)
        .maybeSingle();
      if (tier?.name) productName = tier.name;
    } catch { /* non-fatal */ }

    // The gateway call goes FIRST. If it fails we must not have a row claiming a refund that
    // never left the account — same ordering rule as activation on the approval path.
    await refundPayment(
      {
        transactionId: row.gateway_txn_id,
        paymentMethod: row.gateway_payment_method,
        amount: Number(row.amount || 0),
        productName,
        reason,
      },
      credentials,
    );

    const { data: updated, error: updateError } = await supabaseAdminEngine
      .from('payment_submissions')
      .update({
        status: 'refunded',
        refunded_at: new Date().toISOString(),
        refund_reason: reason,
        reviewed_by: adminId,
        reviewed_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('id', row.id)
      .select('*')
      .single();
    if (updateError) throw updateError;

    // Money leaving the company is worth a log line regardless of whether anything failed.
    await logEvent({
      level: 'info',
      source: 'api',
      message: `Refunded ${row.amount} to owner ${row.owner_id} for ${productName}.`,
      code: 'UDDOKTAPAY_REFUNDED',
      route: '/api/super-admin/payments/[id]/refund',
      method: 'POST',
      userId: adminId,
      context: { paymentId: row.id, transactionId: row.gateway_txn_id, reason },
    });

    return NextResponse.json({ success: true, data: shapeSubmission(updated) }, { status: 200 });
  } catch (err) {
    return apiError(request, err);
  }
}
