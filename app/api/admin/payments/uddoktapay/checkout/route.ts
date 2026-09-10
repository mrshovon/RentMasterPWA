import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import crypto from 'crypto';
import { supabaseAdminEngine } from '@/lib/supabase-server';
import { apiError } from '@/lib/api-response';
import { checkTierPurchasable, findPendingSubmission } from '@/lib/payments/eligibility';
import { availablePaymentMethods, currentCredentials, createCharge } from '@/lib/payments/uddoktapay';
import { resolveAppBaseUrl, resolveApiBaseUrl } from '@/lib/public-url';

// =====================================================================================
// UDDOKTAPAY CHECKOUT — OWNER SIDE
// POST -> start an online payment for a paid tier. Returns { paymentUrl } to redirect to.
//
// Lives under /api/admin/ so middleware.ts injects the owner's identity. Deliberately NO
// assertOwnerCanWrite(): a lapsed or locked owner is exactly who needs to pay, mirroring the
// manual submission route and the subscription route's exemption.
//
// ⭐ A PENDING SUBMISSION ROW IS CREATED BEFORE THE CHARGE, ON PURPOSE.
// Its id goes into the charge's metadata and is the ONLY thing tying the gateway's invoice back
// to an owner and a tier — UddoktaPay hands us that metadata back on both the verify response
// and the webhook. Creating the row afterwards would mean a payment could complete before
// anything existed to attribute it to.
//
// The cost is that an abandoned checkout leaves a 'pending' row, which the one-pending-at-a-time
// rule then blocks the owner behind. That is the same behaviour the manual flow already has, and
// it is the safe direction: a stuck owner asks an admin, whereas a missing row is money we
// cannot account for.
// =====================================================================================

export async function POST(request: NextRequest) {
  try {
    const tenantHeaderId = request.headers.get('x-rentmaster-tenant-id');
    if (tenantHeaderId) {
      return NextResponse.json({ success: false, error: 'Tenants cannot buy plans.' }, { status: 403 });
    }
    const uid = request.headers.get('x-rentmaster-uid');
    if (!uid || uid === 'YOUR_ACTUAL_USER_UUID_FROM_DATABASE') {
      return NextResponse.json({ success: false, error: 'Context matching identity missing.' }, { status: 400 });
    }

    // The admin may have switched the gateway off, or its key may have gone missing, between the
    // owner loading the Plan tab and pressing the button. Re-checked server-side because the UI's
    // copy of this is a convenience, not a control.
    const methods = await availablePaymentMethods();
    if (methods === 'manual') {
      return NextResponse.json(
        { success: false, code: 'GATEWAY_UNAVAILABLE', error: 'Online payment is not available right now.' },
        { status: 400 },
      );
    }

    const credentials = await currentCredentials();
    if (!credentials) {
      return NextResponse.json(
        { success: false, code: 'GATEWAY_UNAVAILABLE', error: 'Online payment is not available right now.' },
        { status: 400 },
      );
    }

    const body = await request.json();
    const tierId = body?.tierId;

    // Same rules as the manual path, from the same place — including the price, which is derived
    // here and never taken from the request. See lib/payments/eligibility.ts.
    const check = await checkTierPurchasable(uid, tierId);
    if (!check.ok) {
      return NextResponse.json(
        { success: false, error: check.error, ...(check.code ? { code: check.code } : {}) },
        { status: check.status },
      );
    }
    const tier = check.tier;
    const amount = Number(check.amount);

    if (await findPendingSubmission(uid)) {
      return NextResponse.json(
        {
          success: false,
          code: 'ALREADY_PENDING',
          error: 'You already have a payment in progress. Please finish or cancel it before starting another.',
        },
        { status: 409 },
      );
    }

    // Identity for the gateway's own receipt. Falls back rather than failing: a missing display
    // name is not a reason to refuse someone's money.
    let ownerEmail = '';
    let ownerName = '';
    try {
      const { data: authRes } = await supabaseAdminEngine.auth.admin.getUserById(uid);
      ownerEmail = authRes?.user?.email || '';
      ownerName = (authRes?.user?.user_metadata as any)?.name || '';
    } catch { /* non-fatal */ }

    const submissionId = crypto.randomUUID(); // no DB default on id — generate it here
    const { error: insertError } = await supabaseAdminEngine.from('payment_submissions').insert([
      {
        id: submissionId,
        owner_id: uid,
        owner_email: ownerEmail || null,
        provider: 'uddoktapay',
        tier_id: tier.id,
        amount,
        // sender_msisdn / txn_id stay null: nobody has typed anything. Fulfilment fills the
        // gateway_* columns instead, and the Payments queue reads those for an online row.
        status: 'pending',
      },
    ]);
    if (insertError) return apiError(request, insertError);

    const appBase = resolveAppBaseUrl(request);
    const apiBase = resolveApiBaseUrl(request);

    let charge;
    try {
      charge = await createCharge(
        {
          fullName: ownerName || ownerEmail || 'Bari360 customer',
          email: ownerEmail || 'no-reply@bari360.space',
          amount,
          metadata: {
            kind: 'owner_subscription',
            submission_id: submissionId,
            owner_id: uid,
            tier_id: String(tier.id),
          },
          redirectUrl: `${appBase}/payment/return`,
          cancelUrl: `${appBase}/payment/cancelled`,
          webhookUrl: `${apiBase}/api/payments/uddoktapay/webhook`,
        },
        credentials,
      );
    } catch (chargeErr) {
      // The charge never started, so the row we just wrote would block this owner from trying
      // again for no reason. Clean it up — it is safe to delete precisely because no invoice id
      // was ever bound to it.
      await supabaseAdminEngine.from('payment_submissions').delete().eq('id', submissionId);
      throw chargeErr;
    }

    return NextResponse.json(
      { success: true, data: { paymentUrl: charge.payment_url, submissionId, amount } },
      { status: 200 },
    );
  } catch (err) {
    return apiError(request, err);
  }
}
