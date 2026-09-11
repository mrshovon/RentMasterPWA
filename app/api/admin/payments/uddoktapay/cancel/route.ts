import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { supabaseAdminEngine } from '@/lib/supabase-server';
import { apiError } from '@/lib/api-response';

// =====================================================================================
// UDDOKTAPAY CANCEL — OWNER SIDE
// POST -> retire the caller's own unfinished online checkout.
//
// Called by /payment/cancelled, the cancel_url registered on every charge. Until this route
// existed that page wrote nothing, so backing out at the gateway left the pending row the
// checkout had created sitting there forever — which told the owner "we've received your
// payment", put a decision in the super admin's queue for money that never moved, and, worst of
// all, blocked that owner from ever starting another payment (the one-pending-at-a-time rule).
//
// ⭐ IT TAKES NO ID, ON PURPOSE.
// The obvious shape is POST { submissionId }, and it is the wrong one: the id would then be
// attacker-controlled and every guard below would be load-bearing against a hostile caller.
// "Cancel whatever unfinished checkout the CALLER has" cannot address someone else's row at all,
// so there is nothing to get wrong.
//
// ⭐ gateway_invoice_id IS NULL IS THE SAFETY PROPERTY.
// That column is written only by fulfilment, and it carries the partial unique index that is this
// feature's idempotency key (ADD_UDDOKTAPAY.sql). A row without one has had no invoice bound to
// it, which is the same as saying no money was ever attached. Carrying it in the WHERE clause
// rather than checking it first makes this atomic against the webhook: if fulfilment lands
// between our read and our write, the update matches zero rows instead of voiding a real payment.
// =====================================================================================

export async function POST(request: NextRequest) {
  try {
    const tenantHeaderId = request.headers.get('x-rentmaster-tenant-id');
    if (tenantHeaderId) {
      return NextResponse.json({ success: false, error: 'Tenants do not have plan payments.' }, { status: 403 });
    }
    const uid = request.headers.get('x-rentmaster-uid');
    if (!uid || uid === 'YOUR_ACTUAL_USER_UUID_FROM_DATABASE') {
      return NextResponse.json({ success: false, error: 'Context matching identity missing.' }, { status: 400 });
    }

    const { data, error } = await supabaseAdminEngine
      .from('payment_submissions')
      .update({
        status: 'cancelled',
        admin_notes: 'Cancelled by the owner before payment.',
        updated_at: new Date().toISOString(),
      })
      .eq('owner_id', uid)
      .eq('provider', 'uddoktapay')
      .eq('status', 'pending')
      .is('gateway_invoice_id', null)
      .select('id');
    if (error) return apiError(request, error);

    const cancelled = (data || []).length;

    // Nothing matched. Two very different reasons, and the owner deserves to be told which:
    // either there was no unfinished attempt (they reloaded the page, or a stale one was already
    // swept), or the payment actually COMPLETED and fulfilment claimed the row first. Saying
    // "cancelled" in the second case would be a lie about someone's money.
    if (cancelled === 0) {
      const { data: recent } = await supabaseAdminEngine
        .from('payment_submissions')
        .select('status, gateway_invoice_id')
        .eq('owner_id', uid)
        .eq('provider', 'uddoktapay')
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      if (recent?.status === 'approved') {
        return NextResponse.json(
          { success: true, data: { outcome: 'completed' as const } },
          { status: 200 },
        );
      }
      return NextResponse.json(
        { success: true, data: { outcome: 'nothing_to_cancel' as const } },
        { status: 200 },
      );
    }

    return NextResponse.json(
      { success: true, data: { outcome: 'cancelled' as const } },
      { status: 200 },
    );
  } catch (err) {
    return apiError(request, err);
  }
}
