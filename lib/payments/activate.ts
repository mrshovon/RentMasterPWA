import { supabaseAdminEngine } from '../supabase-server';

// =====================================================================================
// SHARED PLAN ACTIVATION — the one place that turns a paid tier into an active plan by
// inserting a subscription_history row. The effective plan is always the newest history
// row (see lib/subscription.ts), so this insert instantly activates the tier.
//
// Used by the admin payment-approval route (on approve) and the owner self-signup default
// tier. Expiry is derived from the tier's billing_interval, matching the mocked self-serve
// path that this replaces (app/api/admin/subscription/route.ts:101-110).
// =====================================================================================

export interface ActivateArgs {
  ownerId: string;
  tierId: string;
  amountPaid?: number;
  // Free-text reference stored in gateway_subscription_id (e.g. 'PAYMENT_APPROVED', a bKash
  // txn id, or 'SIGNUP_DEFAULT'). Lets us trace how a plan was activated.
  ref?: string;
}

// The shape computeExpiry needs. Accepts a whole subscription_tiers row.
export interface TenureSource {
  billing_interval?: string | null;
  duration_days?: number | null;
  price?: number | string | null;
}

/**
 * The single source of truth for when an activated plan ends.
 *
 * Returns `null` for a genuinely perpetual free plan — NOT a far-future date.
 *
 * This used to test "price <= 0 => perpetual" BEFORE looking at the billing interval, and
 * wrote `now() + 100 years` for that case. So any tier priced 0 or null — a promo, a trial,
 * a free-for-a-year plan, or one left at the admin form's default price of "0" — got a
 * hundred-year expiry regardless of its real tenure, which is why a 1-year plan bought in
 * 2026 displayed as expiring in 2126. Tenure is now decided first, and price only decides
 * whether a plan is perpetual once no tenure applies.
 *
 * Null is safe here only because resolveOwnerSubscription() short-circuits on tierIsFree()
 * and returns a perpetual state before it ever reads expiry_date. Do NOT return null for a
 * priced tier: on the paid path a missing expiry is read as "ended now" and would lock the
 * owner out of writes immediately.
 */
export function computeExpiry(tier: TenureSource): Date | null {
  const expiry = new Date();
  const days = Number(tier.duration_days ?? 0);
  const interval = tier.billing_interval;

  // 1. An explicit tenure in days always wins, whatever the plan costs.
  if (days > 0) {
    expiry.setDate(expiry.getDate() + days);
    return expiry;
  }

  // 2. Otherwise derive from the billing interval. Calendar arithmetic, not "30 days" —
  //    a monthly plan bought on the 15th should renew on the 15th.
  if (interval === 'year') {
    expiry.setFullYear(expiry.getFullYear() + 1);
    return expiry;
  }
  if (interval === 'month') {
    expiry.setMonth(expiry.getMonth() + 1);
    return expiry;
  }

  // 3. No tenure at all. A free/contact tier is perpetual; anything priced falls back to a
  //    month so it can never be written with a null expiry (which would read as expired).
  if (Number(tier.price || 0) <= 0) return null;
  expiry.setMonth(expiry.getMonth() + 1);
  return expiry;
}

/**
 * Validate the tenure half of a tier create/edit payload. Lives next to computeExpiry so the
 * rules that decide an expiry and the rules that accept one can't drift apart.
 *
 * Returns the value to store in `duration_days` (null unless the interval is 'days').
 */
// NB: a flat result rather than a discriminated union — this project compiles with
// `strict: false`, where narrowing on an `ok: true | false` discriminant does not work.
export interface TenureResult {
  ok: boolean;
  durationDays: number | null;
  error?: string;
}

export function parseTenure(
  billingInterval: string | null | undefined,
  durationDays: unknown
): TenureResult {
  if (billingInterval !== 'days') {
    // A tenure only means something for a 'days' plan — clear it otherwise so a plan
    // switched from "7 days" back to Monthly doesn't keep a stale 7.
    return { ok: true, durationDays: null };
  }
  const n = Number(durationDays);
  if (!Number.isInteger(n) || n <= 0) {
    return { ok: false, durationDays: null, error: 'A custom-length plan needs a whole number of days greater than zero.' };
  }
  if (n > 3650) {
    return { ok: false, durationDays: null, error: 'A plan cannot run longer than 3650 days (10 years).' };
  }
  return { ok: true, durationDays: n };
}

/**
 * Activate `tierId` for `ownerId` by inserting an active subscription_history row.
 * Returns the tier that was activated. Throws if the tier is missing/inactive.
 */
export async function activateSubscription({ ownerId, tierId, amountPaid, ref = 'PAYMENT_APPROVED' }: ActivateArgs) {
  const { data: tier, error: tierErr } = await supabaseAdminEngine
    .from('subscription_tiers')
    .select('*')
    .eq('id', tierId)
    .maybeSingle();
  if (tierErr) throw tierErr;
  if (!tier) throw new Error(`Tier "${tierId}" does not exist.`);
  if (tier.is_active === false) throw new Error(`Tier "${tierId}" is no longer available.`);

  const expiry = computeExpiry(tier);

  const { error: insErr } = await supabaseAdminEngine
    .from('subscription_history')
    .insert({
      owner_id: ownerId,
      tier_id: tier.id,
      gateway_subscription_id: ref,
      amount_paid: amountPaid ?? Number(tier.price || 0),
      status: 'active',
      // null = perpetual (free). Rendered as "Never expires", never as a sentinel date.
      expiry_date: expiry ? expiry.toISOString() : null,
    });
  if (insErr) throw insErr;

  return tier;
}
