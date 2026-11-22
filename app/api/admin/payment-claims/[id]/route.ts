import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { supabaseAdminEngine } from '@/lib/supabase-server';
import { apiError } from '@/lib/api-response';
import { resolveClaim } from '@/lib/payment-claims';

// =====================================================================================
// ONE PAYMENT CLAIM — payee reviews, payer withdraws.
// PATCH { action: 'confirm'|'dismiss' }  -> payee only
// DELETE                                -> payer withdraws a still-pending claim
//
// Confirming a claim does NOT record money. It closes the work queue after the payee has checked
// the reference against their statement. The actual receipt is still recorded through the normal
// billing / building-payment routes, which is the only place balances and ledgers change.
// =====================================================================================

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const payeeId = request.headers.get('x-rentmaster-uid');
    if (!payeeId) return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 });
    const { id } = await params;
    const { action } = await request.json();
    if (action !== 'confirm' && action !== 'dismiss') {
      return NextResponse.json({ error: "Action must be 'confirm' or 'dismiss'." }, { status: 400 });
    }

    const { data: existing } = await supabaseAdminEngine
      .from('payment_claims')
      .select('id, status, source, ref_id, payer_id')
      .eq('id', id).eq('payee_id', payeeId).maybeSingle();
    if (!existing) return NextResponse.json({ error: 'Claim not found.' }, { status: 404 });
    if (existing.status !== 'pending') {
      return NextResponse.json({ error: 'This claim has already been dealt with.' }, { status: 409 });
    }

    const claim = await resolveClaim(id, payeeId, action);

    // Dismissing a rent claim must NOT leave the ledger stuck at "sent" — the tenant would see
    // "awaiting confirmation" for a claim the owner just threw out. The tenant id is in payer_id.
    if (action === 'dismiss' && existing.source === 'rent') {
      await supabaseAdminEngine
        .from('billing_ledgers')
        .update({ payment_status: 'unpaid' })
        .eq('id', existing.ref_id)
        .eq('tenant_id', existing.payer_id)
        .eq('payment_status', 'sent')
        .eq('amount_paid', 0);
    }

    return NextResponse.json({
      success: true,
      message: action === 'confirm' ? 'Claim marked as checked.' : 'Claim dismissed.',
      data: claim,
    }, { status: 200 });
  } catch (err) {
    return apiError(request, err);
  }
}

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const uid = request.headers.get('x-rentmaster-uid');
    const tenantId = request.headers.get('x-rentmaster-tenant-id');
    const payerId = tenantId || uid;
    if (!payerId) return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 });
    const { id } = await params;

    const { data: claim } = await supabaseAdminEngine
      .from('payment_claims')
      .select('id, source, ref_id, status')
      .eq('id', id).eq('payer_id', payerId).maybeSingle();
    if (!claim) return NextResponse.json({ error: 'Claim not found.' }, { status: 404 });
    if (claim.status !== 'pending') {
      return NextResponse.json({ error: 'Only a pending claim can be withdrawn.' }, { status: 409 });
    }

    const { error } = await supabaseAdminEngine
      .from('payment_claims')
      .update({ status: 'dismissed', resolved_at: new Date().toISOString(), resolved_by: payerId })
      .eq('id', id);
    if (error) throw error;

    // Rent's 'sent' flag was set by the claim, so withdrawing it returns the ledger to 'unpaid'
    // — but only while nothing has been recorded against it. A part-payment means the derived
    // status is partial and must not be disturbed.
    if (claim.source === 'rent') {
      await supabaseAdminEngine
        .from('billing_ledgers')
        .update({ payment_status: 'unpaid' })
        .eq('id', claim.ref_id)
        .eq('tenant_id', tenantId)
        .eq('payment_status', 'sent')
        .eq('amount_paid', 0);
    }

    return NextResponse.json({ success: true, message: 'Claim withdrawn.' }, { status: 200 });
  } catch (err) {
    return apiError(request, err);
  }
}
