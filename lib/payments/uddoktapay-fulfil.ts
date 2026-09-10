import crypto from 'crypto';
import { supabaseAdminEngine } from '../supabase-server';
import { sendPushToUsers } from '../push-send';
import { logEvent } from '../logger';
import { activateSubscription } from './activate';
import { currentCredentials, verifyPayment, type VerifyPaymentResult } from './uddoktapay';
import { recalcPlanInvoice, activateBuildingTerm } from '../building-plan';

// =====================================================================================
// UDDOKTAPAY FULFILMENT — the one function that turns a paid invoice into a live plan.
//
// Two things call it, deliberately racing: the owner's browser landing on the return page, and
// UddoktaPay's webhook. Neither is reliable on its own (a browser can be closed mid-redirect; a
// webhook can be blocked, delayed or replayed), and both must be safe to run twice. So this is
// written to be idempotent rather than to be called carefully.
//
// ⭐ WE RE-VERIFY, WE DO NOT TRUST THE CALLER — INCLUDING THE WEBHOOK BODY.
// The webhook arrives with a full payment payload and a shared-secret header. We throw the body
// away and keep only `invoice_id`, then ask the gateway what happened. That costs one HTTPS call
// and buys this: forging a webhook gains an attacker nothing, because the only thing they control
// is which invoice id we look up — and looking up someone else's real invoice still fails the
// ownership and amount checks below. The header check on the route is then defence in depth
// rather than the thing correctness rests on.
//
// ⭐ THE IDEMPOTENCY MECHANISM IS A DATABASE CONSTRAINT, NOT A CHECK-THEN-ACT.
// `claimRow()` does `update … where id = $1 and gateway_invoice_id is null`, and a partial UNIQUE
// index on gateway_invoice_id backs it (ADD_UDDOKTAPAY.sql). Reading the row, deciding it looks
// unfulfilled and then writing would leave a window in which the redirect and the webhook both
// pass; this closes it in the one place where two concurrent requests can be serialised.
// =====================================================================================

export interface FulfilResult {
  /** True when this call performed the fulfilment. False for every other outcome. */
  fulfilled: boolean;
  /** Machine-readable outcome, for the caller to render or log. */
  outcome:
    | 'activated'          // this call did the work
    | 'already_fulfilled'  // someone else got there first — still a success from the user's view
    | 'pending'            // the gateway says the payment has not completed yet
    | 'failed'             // the gateway says it errored
    | 'mismatch'           // it completed, but it does not match what we created
    | 'unconfigured';      // no usable credentials
  message: string;
  /** Set when the payment relates to an owner subscription. */
  tierName?: string;
  status?: string;
}

/** Money comparison in paisa, so 1500 and "1500.00" are equal and float noise cannot bite. */
function sameAmount(a: unknown, b: unknown): boolean {
  return Math.round(Number(a || 0) * 100) === Math.round(Number(b || 0) * 100);
}

export async function fulfilUddoktaPayment(invoiceId: string): Promise<FulfilResult> {
  const credentials = await currentCredentials();
  if (!credentials) {
    return {
      fulfilled: false,
      outcome: 'unconfigured',
      message: 'Online payment is not configured.',
    };
  }

  const verified = await verifyPayment(invoiceId, credentials);

  if (verified.status !== 'COMPLETED') {
    return {
      fulfilled: false,
      outcome: verified.status === 'PENDING' ? 'pending' : 'failed',
      status: verified.status,
      message:
        verified.status === 'PENDING'
          ? 'This payment has not completed yet. If money has left your account, it will be confirmed shortly.'
          : 'This payment did not complete.',
    };
  }

  const kind = verified.metadata?.kind;
  if (kind === 'building_invoice') return fulfilBuildingInvoice(invoiceId, verified);
  return fulfilOwnerSubscription(invoiceId, verified);
}

// -------------------------------------------------------------------------------------
// Owner subscription
// -------------------------------------------------------------------------------------

async function fulfilOwnerSubscription(
  invoiceId: string,
  verified: VerifyPaymentResult,
): Promise<FulfilResult> {
  const submissionId = verified.metadata?.submission_id;
  if (!submissionId) {
    await logMismatch(invoiceId, 'no submission_id in metadata', verified);
    return mismatch();
  }

  const { data: row } = await supabaseAdminEngine
    .from('payment_submissions')
    .select('id, owner_id, tier_id, amount, status, gateway_invoice_id')
    .eq('id', submissionId)
    .maybeSingle();

  if (!row) {
    await logMismatch(invoiceId, 'submission_id does not exist', verified);
    return mismatch();
  }

  // Already done — by the other entry point, or by this one on a retry. Report success: the
  // owner does not care which of the two racing calls did it, only that their plan is on.
  if (row.gateway_invoice_id === invoiceId) return alreadyFulfilled();

  if (row.gateway_invoice_id && row.gateway_invoice_id !== invoiceId) {
    await logMismatch(invoiceId, 'submission already bound to a different invoice', verified);
    return mismatch();
  }
  if (row.status !== 'pending') {
    await logMismatch(invoiceId, `submission is '${row.status}', not pending`, verified);
    return mismatch();
  }

  // Independent amount check — the whole reason we re-verify rather than trusting the redirect.
  // The gateway is telling us what it collected; we compare it with what we asked for.
  if (!sameAmount(verified.amount, row.amount)) {
    await logMismatch(
      invoiceId,
      `amount mismatch: charged ${verified.amount}, expected ${row.amount}`,
      verified,
    );
    return mismatch();
  }

  // ⭐ The claim. Whoever wins this UPDATE owns the fulfilment.
  const claimed = await claimSubmission(row.id, invoiceId);
  if (!claimed) return alreadyFulfilled();

  // Activation is the one irreversible step, and it goes BEFORE the status write — exactly as
  // the manual approval route orders it. If it throws, the row stays 'pending' with the invoice
  // id claimed, which is a re-runnable state; the reverse order would leave a submission marked
  // approved with no plan behind it.
  const tier = await activateSubscription({
    ownerId: row.owner_id,
    tierId: row.tier_id,
    amountPaid: Number(row.amount || 0),
    ref: `UDDOKTA:${invoiceId}`,
  });

  await supabaseAdminEngine
    .from('payment_submissions')
    .update({
      status: 'approved',
      // Null, not an admin uid: nobody approved this. The Payments queue renders that as
      // "Paid online", which is the honest description of what happened.
      reviewed_by: null,
      reviewed_at: new Date().toISOString(),
      admin_notes: 'Paid online via UddoktaPay.',
      gateway_txn_id: verified.transaction_id || null,
      gateway_payment_method: verified.payment_method || null,
      updated_at: new Date().toISOString(),
    })
    .eq('id', row.id);

  const tierName = tier?.name || row.tier_id;

  // Fire-and-forget, same as the manual path: a push failure must never fail a paid transaction.
  try {
    await sendPushToUsers([row.owner_id], {
      title: 'Payment received',
      body: `Your ${tierName} plan is now active. Thank you!`,
      url: '/owner#plan',
      tag: `payment-${row.id}`,
    });
  } catch (pushErr) {
    console.error('[uddoktapay] push dispatch failed (non-fatal):', pushErr);
  }

  return {
    fulfilled: true,
    outcome: 'activated',
    tierName,
    message: `Your ${tierName} plan is now active.`,
  };
}

// -------------------------------------------------------------------------------------
// Whole Building plan invoice
// -------------------------------------------------------------------------------------

async function fulfilBuildingInvoice(
  invoiceId: string,
  verified: VerifyPaymentResult,
): Promise<FulfilResult> {
  const planInvoiceId = verified.metadata?.invoice_id;
  if (!planInvoiceId) {
    await logMismatch(invoiceId, 'no invoice_id in metadata', verified);
    return mismatch();
  }

  // The claim here is the INSERT itself: the partial unique index on gateway_invoice_id makes a
  // second insert for the same gateway invoice fail with 23505 rather than double-credit the
  // building. That is why there is no read-then-write around it.
  const { data: invoice } = await supabaseAdminEngine
    .from('building_plan_invoices')
    .select('id, building_id, admin_id, term_months, period_start, total_payable, amount_paid')
    .eq('id', planInvoiceId)
    .maybeSingle();

  if (!invoice) {
    await logMismatch(invoiceId, 'building_plan_invoice does not exist', verified);
    return mismatch();
  }

  const amount = Number(verified.amount || 0);
  const { error: insErr } = await supabaseAdminEngine.from('building_plan_payments').insert([
    {
      id: crypto.randomUUID(),
      invoice_id: invoice.id,
      building_id: invoice.building_id,
      admin_id: invoice.admin_id,
      amount,
      paid_on: new Date().toISOString().slice(0, 10),
      // 'card' is the closest of the allowed methods; the real instrument (bkash/nagad/…) is in
      // `reference` alongside the transaction id, which is what anyone reconciling will read.
      method: 'card',
      reference: `${verified.payment_method || 'online'}:${verified.transaction_id || invoiceId}`,
      // Null: no admin collected this, the gateway did.
      recorded_by: null,
      note: 'Paid online via UddoktaPay.',
      gateway_invoice_id: invoiceId,
    },
  ]);

  if (insErr) {
    // 23505 = the unique index did its job; a duplicate webhook or a page reload.
    if ((insErr as any).code === '23505') return alreadyFulfilled();
    throw insErr;
  }

  const updated: any = await recalcPlanInvoice(invoice.id);

  if (updated?.payment_status === 'paid') {
    await activateBuildingTerm(invoice.building_id, {
      months: Number(updated.term_months || invoice.term_months || 12),
      startOn: /^\d{4}-\d{2}-\d{2}$/.test(String(invoice.period_start || '').slice(0, 10))
        ? String(invoice.period_start).slice(0, 10)
        : null,
    });
  }

  try {
    await sendPushToUsers([invoice.admin_id], {
      title: updated?.payment_status === 'paid' ? 'Payment received — plan renewed' : 'Payment received',
      body: `৳${amount} received for invoice #${planInvoiceId.slice(0, 8)}.`,
      url: '/building#plan',
      tag: `building-plan-${invoice.id}`,
    });
  } catch (pushErr) {
    console.error('[uddoktapay] building push failed (non-fatal):', pushErr);
  }

  return {
    fulfilled: true,
    outcome: 'activated',
    message:
      updated?.payment_status === 'paid'
        ? 'Payment received in full — the plan term has been renewed.'
        : 'Payment received and recorded against the invoice.',
  };
}

// -------------------------------------------------------------------------------------
// helpers
// -------------------------------------------------------------------------------------

/**
 * Bind the gateway invoice to this submission, but only if nothing has bound it yet.
 * Returns true when THIS call won.
 */
async function claimSubmission(submissionId: string, invoiceId: string): Promise<boolean> {
  const { data, error } = await supabaseAdminEngine
    .from('payment_submissions')
    .update({ gateway_invoice_id: invoiceId, updated_at: new Date().toISOString() })
    .eq('id', submissionId)
    .is('gateway_invoice_id', null)
    .select('id');
  // 23505 means another request bound this same invoice id to a different row in the gap. Treat
  // it as a loss, not an error: the other request is fulfilling it.
  if (error) {
    if ((error as any).code === '23505') return false;
    throw error;
  }
  return (data?.length ?? 0) > 0;
}

function alreadyFulfilled(): FulfilResult {
  return {
    fulfilled: false,
    outcome: 'already_fulfilled',
    message: 'This payment has already been processed.',
  };
}

function mismatch(): FulfilResult {
  return {
    fulfilled: false,
    outcome: 'mismatch',
    // Deliberately vague to the user. The detail is in app_logs, where an admin can act on it;
    // telling a caller which check failed tells an attacker which one to fix.
    message:
      'We could not match this payment to an order. Please contact support with your payment reference.',
  };
}

/**
 * A COMPLETED payment that we refused to fulfil is the most important thing in this file to be
 * able to find later: real money moved and the app did nothing with it. Always logged at error.
 */
async function logMismatch(invoiceId: string, why: string, verified: VerifyPaymentResult) {
  await logEvent({
    level: 'error',
    source: 'api',
    message: `UddoktaPay: COMPLETED payment not fulfilled — ${why}`,
    code: 'UDDOKTAPAY_MISMATCH',
    context: {
      invoiceId,
      transactionId: verified.transaction_id,
      amount: verified.amount,
      metadata: verified.metadata,
    },
  });
}
