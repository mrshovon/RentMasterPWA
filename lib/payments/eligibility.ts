import { supabaseAdminEngine } from '../supabase-server';
import {
  resolveOwnerSubscription,
  tierVisibleToOwner,
  tierIsOneTime,
  ownerUsedTierIds,
} from '../subscription';
import { buildingMembershipOf } from '../building';

// =====================================================================================
// "MAY THIS OWNER BUY THIS TIER, AND FOR HOW MUCH?"
//
// Extracted verbatim from app/api/admin/payments/route.ts POST, which was the only payment
// entry point until the gateway arrived. There are now two, and these checks are the difference
// between a plan being bought legitimately and a leaked tier id being bought at the wrong price.
// Two copies of that WILL drift; whichever copy is forgotten becomes the way in.
//
// ⭐ THE PRICE IS DERIVED HERE, NEVER ACCEPTED FROM THE CLIENT.
// The manual flow could afford to take the owner's word for the amount — an admin reads it off a
// bKash statement before approving, so a wrong number is caught by a human. A gateway has no such
// step: whatever amount we put in the charge is what gets taken and what fulfilment then matches
// against. So `amount` is computed from the tier and the admin's discount, and the caller has no
// say in it.
// =====================================================================================

export interface EligibilityResult {
  ok: boolean;
  /** The subscription_tiers row, when ok. */
  tier?: any;
  /** What this owner should actually be charged, after any admin discount. */
  amount?: number;
  /** HTTP status for the refusal, when not ok. */
  status?: number;
  /** User-facing refusal message. */
  error?: string;
  /** Machine-readable refusal, matching the codes the frontend already handles. */
  code?: string;
}

// NB: a flat result rather than a discriminated union — this project compiles with
// `strict: false`, where narrowing on an `ok: true | false` discriminant does not work.
// Same reasoning as TenureResult in activate.ts.
export async function checkTierPurchasable(
  ownerId: string,
  tierId: string,
): Promise<EligibilityResult> {
  if (!tierId) {
    return { ok: false, status: 400, error: 'A plan is required.' };
  }

  // A flat owner under a Whole Building plan does not pay us — their building admin does.
  // Refused here, not merely hidden in the UI, so a stray payment can never enter the admin's
  // reconciliation queue for money nobody expected.
  const membership = await buildingMembershipOf(ownerId);
  if (membership) {
    return {
      ok: false,
      status: 403,
      code: 'BUILDING_MANAGED_PLAN',
      error: `Your plan is covered by ${membership.buildingName}. There is nothing to pay here — contact your building administrator.`,
    };
  }

  const { data: tier, error: tierErr } = await supabaseAdminEngine
    .from('subscription_tiers')
    .select('*')
    .eq('id', tierId)
    .maybeSingle();
  if (tierErr) throw tierErr;
  if (!tier || tier.is_active === false) {
    return { ok: false, status: 400, error: 'That plan is not available.' };
  }

  // Hidden plans are admin-assigned only, so a leaked tier id must not be payable. The owner
  // already ON the plan is allowed through — that is the renewal path, and without it a bespoke
  // plan would be impossible to pay for a second time.
  const currentSub = await resolveOwnerSubscription(ownerId);
  if (!tierVisibleToOwner(tier, currentSub.tierId)) {
    return { ok: false, status: 400, error: 'That plan is not available.' };
  }

  if (tier.billing_interval === 'custom') {
    return {
      ok: false,
      status: 400,
      error: 'That plan is arranged with our team — please use Contact us.',
    };
  }

  // One-time plans can be taken once. Guarded on every path — otherwise a paid trial could
  // simply be re-bought through whichever screen forgot to check.
  if (tierIsOneTime(tier) && (await ownerUsedTierIds(ownerId)).has(tier.id)) {
    return {
      ok: false,
      status: 400,
      code: 'ONE_TIME_PLAN_USED',
      error: `${tier.name} is a one-time plan and you have already used it. Please choose another plan.`,
    };
  }

  if (Number(tier.price || 0) <= 0) {
    return { ok: false, status: 400, error: 'The free plan does not require a payment.' };
  }

  return { ok: true, tier, amount: priceForOwner(tier) };
}

/**
 * The price after any admin discount — what the owner is actually shown on the plan card.
 * Mirrors discountedPrice() on the frontend (lib/plan-format.ts); billing the list price would
 * charge someone for a discount they were quoted.
 *
 * Rounded to two decimals because it is about to become a currency string.
 */
export function priceForOwner(tier: any): number {
  const list = Number(tier.price || 0);
  const off = Number(tier.discount_percent || 0);
  return Math.round(list * (1 - off / 100) * 100) / 100;
}

/** What a pending row is, to the callers that have to decide whether it really blocks. */
export interface PendingSubmission {
  id: string;
  provider: string;
  /**
   * Written only at fulfilment, and carrying the partial unique index that is this feature's
   * idempotency key. So a NULL here means no gateway invoice was ever bound to this row, which
   * is the same as saying no money was ever attached to it. Every automatic cancel in this
   * codebase is guarded on it — see ADD_PAYMENT_CANCELLED.sql.
   */
  gateway_invoice_id: string | null;
  created_at: string;
}

/**
 * One pending submission at a time — avoids a queue of duplicates from repeat taps.
 * Shared so the gateway cannot open a second checkout behind an unfinished manual submission,
 * or vice versa.
 *
 * Returns the whole row rather than just its id: the gateway checkout has to tell an owner who
 * really is mid-payment apart from one whose browser died three days ago, and it cannot do that
 * from an id. Both callers still treat a truthy answer as blocking by default.
 */
export async function findPendingSubmission(ownerId: string): Promise<PendingSubmission | null> {
  const { data } = await supabaseAdminEngine
    .from('payment_submissions')
    .select('id, provider, gateway_invoice_id, created_at')
    .eq('owner_id', ownerId)
    .eq('status', 'pending')
    .limit(1)
    .maybeSingle();
  return (data as PendingSubmission | null) ?? null;
}

/**
 * How long an unfinished gateway checkout blocks the next one.
 *
 * Long enough that nobody is interrupted mid-payment — an UddoktaPay session is minutes, not
 * half an hour — and short enough that a closed tab is not a support ticket.
 */
export const STALE_CHECKOUT_MS = 30 * 60 * 1000;

/**
 * True when a pending row is a gateway checkout that was opened, never completed, and has since
 * gone stale. Such a row represents nothing: no invoice was ever bound to it, so there is no
 * payment to lose by retiring it.
 *
 * A manual_bkash row can never qualify. Someone really did send money and is waiting on a human,
 * and no timer should make that disappear.
 */
export function isStaleCheckout(row: PendingSubmission, now = Date.now()): boolean {
  if (row.provider !== 'uddoktapay') return false;
  if (row.gateway_invoice_id) return false;
  const started = Date.parse(row.created_at);
  // An unparseable timestamp is not evidence of staleness — leave the row alone.
  if (!Number.isFinite(started)) return false;
  return now - started > STALE_CHECKOUT_MS;
}
