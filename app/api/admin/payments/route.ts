import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { supabaseAdminEngine } from '@/lib/supabase-server';
import { sendPushToRole } from '@/lib/push-send';
import { DEFAULT_PROVIDER_ID } from '@/lib/payments/registry';
import crypto from 'crypto';

// =====================================================================================
// PAYMENT SUBMISSIONS — OWNER SIDE
// GET  -> the owner's own submissions (newest first), so the Plan tab can show pending /
//         approved / rejected status and any rejection remarks.
// POST -> submit a manual bKash payment for a paid tier (status 'pending' for admin review).
//
// Lives under /api/admin/ because middleware.ts injects x-rentmaster-* identity there.
// Deliberately NO assertOwnerCanWrite(): a lapsed/locked owner is exactly who needs to pay,
// mirroring the subscription route's exemption.
// =====================================================================================

function ownerId(request: NextRequest): string | null {
  const id = request.headers.get('x-rentmaster-uid');
  if (!id || id === 'YOUR_ACTUAL_USER_UUID_FROM_DATABASE') return null;
  return id;
}

export async function GET(request: NextRequest) {
  try {
    const uid = ownerId(request);
    if (!uid) return NextResponse.json({ error: 'Context matching identity missing.' }, { status: 400 });

    const { data, error } = await supabaseAdminEngine
      .from('payment_submissions')
      .select('*')
      .eq('owner_id', uid)
      .order('created_at', { ascending: false });
    if (error) throw error;

    return NextResponse.json({ success: true, count: data?.length || 0, data: data || [] }, { status: 200 });
  } catch (err: any) {
    console.error('[payments] owner GET error:', err);
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const tenantHeaderId = request.headers.get('x-rentmaster-tenant-id');
    if (tenantHeaderId) {
      return NextResponse.json({ error: 'Tenants cannot submit payments.' }, { status: 403 });
    }
    const uid = ownerId(request);
    if (!uid) return NextResponse.json({ error: 'Context matching identity missing.' }, { status: 400 });

    const body = await request.json();
    const { tierId, amount, senderMsisdn, txnId } = body;

    if (!tierId) return NextResponse.json({ success: false, error: 'A plan is required.' }, { status: 400 });
    if (!txnId?.trim()) return NextResponse.json({ success: false, error: 'The bKash transaction id is required.' }, { status: 400 });
    if (!senderMsisdn?.trim()) return NextResponse.json({ success: false, error: 'The mobile number you paid from is required.' }, { status: 400 });

    // Validate the tier: must exist, be active, be a paid non-custom tier.
    const { data: tier, error: tierErr } = await supabaseAdminEngine
      .from('subscription_tiers')
      .select('*')
      .eq('id', tierId)
      .maybeSingle();
    if (tierErr) throw tierErr;
    if (!tier || tier.is_active === false) {
      return NextResponse.json({ success: false, error: 'That plan is not available.' }, { status: 400 });
    }
    if (tier.billing_interval === 'custom') {
      return NextResponse.json({ success: false, error: 'That plan is arranged with our team — please use Contact us.' }, { status: 400 });
    }
    if (Number(tier.price || 0) <= 0) {
      return NextResponse.json({ success: false, error: 'The free plan does not require a payment.' }, { status: 400 });
    }

    // One pending submission at a time — avoids a queue of duplicates from repeat taps.
    const { data: existingPending } = await supabaseAdminEngine
      .from('payment_submissions')
      .select('id')
      .eq('owner_id', uid)
      .eq('status', 'pending')
      .limit(1)
      .maybeSingle();
    if (existingPending) {
      return NextResponse.json({
        success: false,
        code: 'ALREADY_PENDING',
        error: 'You already have a payment awaiting approval. Please wait for it to be reviewed.',
      }, { status: 409 });
    }

    // Snapshot the owner's email for the admin queue.
    let ownerEmail: string | null = null;
    try {
      const { data: authRes } = await supabaseAdminEngine.auth.admin.getUserById(uid);
      ownerEmail = authRes?.user?.email || null;
    } catch { /* non-fatal: the queue enriches from listUsers anyway */ }

    const paymentId = crypto.randomUUID(); // no DB default on id — generate it here
    const { data: row, error: insertError } = await supabaseAdminEngine
      .from('payment_submissions')
      .insert([
        {
          id: paymentId,
          owner_id: uid,
          owner_email: ownerEmail,
          provider: DEFAULT_PROVIDER_ID,
          tier_id: tier.id,
          amount: amount != null && amount !== '' ? Number(amount) : Number(tier.price || 0),
          sender_msisdn: String(senderMsisdn).trim(),
          txn_id: String(txnId).trim(),
          status: 'pending',
        },
      ])
      .select('*')
      .single();

    if (insertError) {
      console.error('[payments] insert failed:', insertError);
      return NextResponse.json({ success: false, error: insertError.message }, { status: 500 });
    }

    // Buzz the system admins. Fire-and-forget: a push failure must never fail the submission.
    try {
      await sendPushToRole('admin', {
        title: 'New payment to review',
        body: `${tier.name} — ৳${Number(row.amount || 0)} (txn ${row.txn_id}).`,
        url: '/admin#payments',
        tag: `payment-${paymentId}`,
      });
    } catch (pushErr) {
      console.error('[payments] push dispatch failed (non-fatal):', pushErr);
    }

    return NextResponse.json({ success: true, data: row }, { status: 201 });
  } catch (err: any) {
    console.error('[payments] POST crash:', err);
    return NextResponse.json({ success: false, error: err.message || 'Fatal Server Logic Exception.' }, { status: 500 });
  }
}
