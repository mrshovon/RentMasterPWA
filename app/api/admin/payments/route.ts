import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { supabaseAdminEngine } from '@/lib/supabase-server';
import { sendPushToRole } from '@/lib/push-send';
import { DEFAULT_PROVIDER_ID } from '@/lib/payments/registry';
import { encryptSubmissionFields, shapeSubmission, PaymentFieldError } from '@/lib/payments/submissions';
import { validatePhone } from '@/lib/validate';
import { checkTierPurchasable, findPendingSubmission } from '@/lib/payments/eligibility';
import crypto from 'crypto';
import { apiError } from '@/lib/api-response';

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

    const shaped = (data || []).map(shapeSubmission);

    return NextResponse.json({ success: true, count: shaped.length, data: shaped }, { status: 200 });
  } catch (err) {
    return apiError(request, err);
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

    if (!txnId?.trim()) return NextResponse.json({ success: false, error: 'The bKash transaction id is required.' }, { status: 400 });
    // The admin reconciles this submission against the bKash statement by number, so a
    // malformed one produces a payment that can never be matched to a plan.
    const parsedMsisdn = validatePhone(senderMsisdn, { required: true });
    if (!parsedMsisdn.ok) return NextResponse.json({ success: false, error: parsedMsisdn.error }, { status: 400 });

    // Every 'may they buy this, and for how much' rule lives in one place, shared with the
    // UddoktaPay checkout route — see lib/payments/eligibility.ts for why.
    const check = await checkTierPurchasable(uid, tierId);
    if (!check.ok) {
      return NextResponse.json(
        { success: false, error: check.error, ...(check.code ? { code: check.code } : {}) },
        { status: check.status },
      );
    }
    const tier = check.tier;

    if (await findPendingSubmission(uid)) {
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
          // The owner types what they say they paid; the admin reconciles it by eye before
          // approving, which is what makes accepting a client value safe HERE and not on the
          // gateway path. check.amount is the discounted price they were quoted.
          amount: amount != null && amount !== '' ? Number(amount) : check.amount,
          // Encrypted at rest — the payer's number and the transaction id together tie a person
          // to a financial transaction. Decrypted back for the owner and the admin queue by
          // shapeSubmission(). See lib/payments/submissions.ts.
          ...encryptSubmissionFields(parsedMsisdn.value, String(txnId).trim()),
          status: 'pending',
        },
      ])
      .select('*')
      .single();

    if (insertError) {
      return apiError(request, insertError);
    }

    // The stored columns are ciphertext now, so read the identifiers back from the shaped row
    // rather than the raw one — otherwise the admin push would say "txn null".
    const shaped = shapeSubmission(row);

    // Buzz the system admins. Fire-and-forget: a push failure must never fail the submission.
    try {
      await sendPushToRole('admin', {
        title: 'New payment to review',
        body: `${tier.name} — ৳${Number(shaped.amount || 0)} (txn ${shaped.txn_id}).`,
        url: '/admin#payments',
        tag: `payment-${paymentId}`,
      });
    } catch (pushErr) {
      console.error('[payments] push dispatch failed (non-fatal):', pushErr);
    }

    return NextResponse.json({ success: true, data: shaped }, { status: 201 });
  } catch (err) {
    // A missing encryption key is a server misconfiguration, but it is the owner who is standing
    // there unable to pay — give them the reason rather than a generic 500 with a reference id.
    if (err instanceof PaymentFieldError) {
      return NextResponse.json({ success: false, error: err.message }, { status: 400 });
    }
    return apiError(request, err);
  }
}
