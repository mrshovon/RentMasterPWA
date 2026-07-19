import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { supabaseAdminEngine } from '@/lib/supabase-server';
import { sendPushToUsers } from '@/lib/push-send';
import { activateSubscription } from '@/lib/payments/activate';

// =====================================================================================
// PAYMENT SUBMISSIONS — ADMIN DECISION
// PATCH -> approve or reject a pending submission.
//   approved -> activate the owner's tier (insert an active subscription_history row) and notify.
//   rejected -> record the remarks (admin_notes) and notify the owner why.
// Admin-only via the /api/super-admin/* gate in middleware.ts. Idempotent-ish: a row already
// approved is never re-activated (guards against a double-click minting two plans).
// =====================================================================================

const VALID_STATUS = ['approved', 'rejected'];

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id: paymentId } = await params; // params is a Promise in Next 16
    const adminId = request.headers.get('x-rentmaster-uid');

    const { status, adminNotes } = await request.json();

    if (status === undefined && adminNotes === undefined) {
      return NextResponse.json({ success: false, error: 'Nothing to update.' }, { status: 400 });
    }
    if (status !== undefined && !VALID_STATUS.includes(status)) {
      return NextResponse.json(
        { success: false, error: `Status must be one of: ${VALID_STATUS.join(', ')}.` },
        { status: 400 },
      );
    }
    if (status === 'rejected' && !adminNotes?.trim()) {
      return NextResponse.json({ success: false, error: 'A remark is required to reject a payment.' }, { status: 400 });
    }

    // Read the row first: we need owner_id/tier_id to activate + push, and the current status
    // to avoid re-activating an already-approved payment.
    const { data: existing, error: readError } = await supabaseAdminEngine
      .from('payment_submissions')
      .select('id, owner_id, tier_id, amount, status')
      .eq('id', paymentId)
      .single();

    if (readError || !existing) {
      return NextResponse.json({ success: false, error: 'Payment not found.' }, { status: 404 });
    }
    if (existing.status !== 'pending' && status !== undefined) {
      return NextResponse.json({
        success: false,
        error: `This payment was already ${existing.status}.`,
      }, { status: 409 });
    }

    // On approval, activate the plan FIRST — if activation fails we must not mark it approved.
    let activatedTierName: string | null = null;
    if (status === 'approved') {
      const tier = await activateSubscription({
        ownerId: existing.owner_id,
        tierId: existing.tier_id,
        amountPaid: Number(existing.amount || 0),
        ref: `BKASH:${paymentId}`,
      });
      activatedTierName = tier?.name || existing.tier_id;
    }

    const updates: Record<string, any> = { updated_at: new Date().toISOString() };
    if (adminNotes !== undefined) updates.admin_notes = adminNotes || null;
    if (status !== undefined) {
      updates.status = status;
      updates.reviewed_by = adminId || null;
      updates.reviewed_at = new Date().toISOString();
    }

    const { data: row, error: updateError } = await supabaseAdminEngine
      .from('payment_submissions')
      .update(updates)
      .eq('id', paymentId)
      .select('*')
      .single();

    if (updateError) {
      console.error('Admin Payment PATCH error:', updateError);
      return NextResponse.json({ success: false, error: updateError.message }, { status: 500 });
    }

    // Tell the owner the outcome. Fire-and-forget: never fail the response.
    if (status !== undefined) {
      try {
        const payload = status === 'approved'
          ? { title: 'Payment approved', body: `Your ${activatedTierName} plan is now active. Thank you!`, url: '/owner#plan', tag: `payment-${paymentId}` }
          : { title: 'Payment could not be approved', body: adminNotes?.trim() || 'Please review and resubmit your payment.', url: '/owner#plan', tag: `payment-${paymentId}` };
        await sendPushToUsers([existing.owner_id], payload);
      } catch (pushErr) {
        console.error('[payments] push dispatch failed (non-fatal):', pushErr);
      }
    }

    return NextResponse.json({ success: true, data: row }, { status: 200 });
  } catch (err: any) {
    console.error('Admin Payment PATCH crash:', err);
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}
