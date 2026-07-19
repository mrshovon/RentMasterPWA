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

// Compute the expiry for a tier: free -> far-future sentinel, yearly -> +1yr, else +30d.
export function computeExpiry(billingInterval: string | null | undefined, price: number): Date {
  const expiry = new Date();
  if (Number(price || 0) <= 0) {
    expiry.setFullYear(expiry.getFullYear() + 100);
  } else if (billingInterval === 'year') {
    expiry.setFullYear(expiry.getFullYear() + 1);
  } else {
    expiry.setDate(expiry.getDate() + 30);
  }
  return expiry;
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

  const expiry = computeExpiry(tier.billing_interval, Number(tier.price || 0));

  const { error: insErr } = await supabaseAdminEngine
    .from('subscription_history')
    .insert({
      owner_id: ownerId,
      tier_id: tier.id,
      gateway_subscription_id: ref,
      amount_paid: amountPaid ?? Number(tier.price || 0),
      status: 'active',
      expiry_date: expiry.toISOString(),
    });
  if (insErr) throw insErr;

  return tier;
}
