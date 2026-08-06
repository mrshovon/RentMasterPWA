import { supabaseAdminEngine } from './supabase-server';

// =====================================================================================
// 📦 SUBSCRIPTION LIFECYCLE — single source of truth for owner plan enforcement.
//
// Rules (see plan): Free tier is perpetual (never expires), capped by its tier limits.
// A new owner with no history row is treated as Free automatically. Paid/monthly plans
// run: active -> (<=10d left) warn -> (past expiry, <=10d) grace (writes still allowed)
// -> (>10d past expiry) LOCKED. An admin `permissions_revoked` flag also forces LOCKED.
// =====================================================================================

export const GRACE_DAYS = 10;      // buffer after expiry before writes are locked
export const EXPIRY_WARN_DAYS = 10; // warn this many days before a paid plan expires
const DAY_MS = 24 * 60 * 60 * 1000;

// Fallback Free limits if the free_tier row is somehow missing.
const FREE_FALLBACK = { maxProperties: 2, maxTenants: 2 };

export interface OwnerSubscription {
  tierId: string;
  tierName: string;
  interval: string;            // 'month' | 'year' | ...
  price: number;
  isFree: boolean;
  status: 'active' | 'grace' | 'locked';
  expiryDate: string | null;   // null => perpetual (free)
  daysUntilExpiry: number | null;
  graceEndsAt: string | null;
  daysLeftInGrace: number | null;
  warnExpiringSoon: boolean;    // paid && 0 < daysUntilExpiry <= EXPIRY_WARN_DAYS
  limits: { maxProperties: number; maxTenants: number }; // -1 = unlimited
  permissionsRevoked: boolean;
  lockReason: 'expired' | 'revoked' | null;
}

// "Free" here means the perpetual Free baseline, not merely "costs nothing". A tier that
// states an explicit tenure (a 7-day free trial, say) is time-limited by definition, so it
// must run the normal expiry/grace/lock lifecycle rather than being treated as perpetual —
// otherwise a zero-price trial would never end.
/**
 * May this owner see and choose this plan?
 *
 * The single source of truth for plan visibility — the owner plan list, self-activation and the
 * payment route all defer to it, because three copies of this rule would drift.
 *
 * A hidden plan (`is_public = false`, see ADD_PLAN_VISIBILITY.sql) is invisible and unusable to
 * owners, with one exception: the owner already ON it. Without that exception a bespoke plan
 * would be unrenewable — the owner could not see it to pay again, and would drift into grace and
 * then lock at expiry with no way out except the admin re-assigning it by hand.
 *
 * Note `is_public !== false`, not `=== true`: before the migration runs the field is undefined,
 * and every plan must keep behaving exactly as it does today.
 */
export function tierVisibleToOwner(tier: any, currentTierId?: string | null): boolean {
  if (!tier) return false;
  if (tier.is_active === false) return false;   // retired: nobody, ever
  if (tier.is_public !== false) return true;    // listed (or pre-migration)
  return !!currentTierId && tier.id === currentTierId;
}

function tierIsFree(tier: any): boolean {
  if (!tier) return true;
  if (Number(tier.duration_days || 0) > 0 || tier.billing_interval === 'days') return false;
  return Number(tier.price || 0) <= 0;
}

async function loadFreeLimits(): Promise<{ maxProperties: number; maxTenants: number }> {
  // `select('*')` and filter in JS rather than naming columns: referencing `is_public` in the
  // column list would 42703 on any database where ADD_PLAN_VISIBILITY.sql has not been run, and
  // this query decides the limits for EVERY planless owner.
  const { data } = await supabaseAdminEngine
    .from('subscription_tiers')
    .select('*')
    .lte('price', 0)
    // Exclude enterprise/contact tiers (e.g. Whole Building) and time-limited free trials —
    // neither is the perpetual baseline a planless owner should fall back to.
    .not('billing_interval', 'in', '("custom","days")')
    .order('price', { ascending: true })
    .order('max_properties_allowed', { ascending: true }); // prefer the most restrictive baseline

  // A hidden plan must never become the baseline: it would hand its limits to every owner who
  // has no plan at all, which is the opposite of "only the people I assign it to".
  const baseline = (data || []).find((t: any) => t.is_active !== false && t.is_public !== false);
  if (!baseline) return { ...FREE_FALLBACK };
  return {
    maxProperties: baseline.max_properties_allowed ?? FREE_FALLBACK.maxProperties,
    maxTenants: baseline.max_tenants_allowed ?? FREE_FALLBACK.maxTenants,
  };
}

function freeState(limits: { maxProperties: number; maxTenants: number }, revoked: boolean): OwnerSubscription {
  return {
    tierId: 'free_tier',
    tierName: 'Free Baseline',
    interval: 'perpetual',
    price: 0,
    isFree: true,
    status: revoked ? 'locked' : 'active',
    expiryDate: null,
    daysUntilExpiry: null,
    graceEndsAt: null,
    daysLeftInGrace: null,
    warnExpiringSoon: false,
    limits,
    permissionsRevoked: revoked,
    lockReason: revoked ? 'revoked' : null,
  };
}

/**
 * Resolve the effective subscription state for an owner. Never throws for "no plan" —
 * a planless owner resolves to a perpetual Free state.
 */
export async function resolveOwnerSubscription(ownerId: string): Promise<OwnerSubscription> {
  // Admin-controlled hard revoke flag lives in auth user_metadata.
  let permissionsRevoked = false;
  try {
    const { data: authRes } = await supabaseAdminEngine.auth.admin.getUserById(ownerId);
    permissionsRevoked = !!((authRes?.user?.user_metadata as any)?.permissions_revoked);
  } catch {
    /* if the auth lookup fails we simply don't apply the revoke flag */
  }

  const { data: latest } = await supabaseAdminEngine
    .from('subscription_history')
    // `( * )` rather than a column list on purpose: naming `duration_days` here would make
    // this whole query fail with 42703 on any database where ADD_PLAN_TENURE.sql has not
    // been run yet, and that would take every owner's plan resolution down with it.
    .select('*, subscription_tiers:tier_id ( * )')
    .eq('owner_id', ownerId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  const tier = (latest as any)?.subscription_tiers;

  // No history row, or the latest plan is Free -> perpetual Free state.
  if (!latest || tierIsFree(tier)) {
    const limits = await loadFreeLimits();
    const s = freeState(limits, permissionsRevoked);
    if (tier && tierIsFree(tier)) {
      s.tierId = tier.id;
      s.tierName = tier.name || s.tierName;
      s.limits = {
        maxProperties: tier.max_properties_allowed ?? limits.maxProperties,
        maxTenants: tier.max_tenants_allowed ?? limits.maxTenants,
      };
    }
    return s;
  }

  // Paid tier -> apply the expiry/grace/lock lifecycle.
  const limits = {
    maxProperties: tier.max_properties_allowed ?? -1,
    maxTenants: tier.max_tenants_allowed ?? -1,
  };
  const now = Date.now();
  const canceled = latest.status === 'canceled';
  const endRaw = canceled && latest.canceled_at ? latest.canceled_at : latest.expiry_date;
  const end = endRaw ? new Date(endRaw).getTime() : now; // missing expiry => treat as ended now
  const graceEnd = end + GRACE_DAYS * DAY_MS;

  let status: OwnerSubscription['status'];
  let lockReason: OwnerSubscription['lockReason'] = null;
  if (permissionsRevoked) {
    status = 'locked';
    lockReason = 'revoked';
  } else if (now < end) {
    status = 'active';
  } else if (now < graceEnd) {
    status = 'grace';
  } else {
    status = 'locked';
    lockReason = 'expired';
  }

  const daysUntilExpiry = Math.ceil((end - now) / DAY_MS); // negative once expired
  const daysLeftInGrace = status === 'grace' ? Math.max(0, Math.ceil((graceEnd - now) / DAY_MS)) : null;
  const warnExpiringSoon = status === 'active' && daysUntilExpiry > 0 && daysUntilExpiry <= EXPIRY_WARN_DAYS;

  return {
    tierId: tier.id,
    tierName: tier.name || tier.id,
    interval: tier.billing_interval || 'month',
    price: Number(tier.price || 0),
    isFree: false,
    status,
    expiryDate: endRaw || null,
    daysUntilExpiry,
    graceEndsAt: new Date(graceEnd).toISOString(),
    daysLeftInGrace,
    warnExpiringSoon,
    limits,
    permissionsRevoked,
    lockReason,
  };
}

export interface WriteGuardResult {
  ok: boolean;
  status?: number;
  body?: { error: string; code: string; lockReason?: string | null };
}

/**
 * Gate an owner "write/task" action on subscription state. No-op (ok) for any caller
 * whose role is not 'owner' (tenants + admins are never blocked by an owner's plan).
 */
export async function assertOwnerCanWrite(role: string | null, ownerId: string | null): Promise<WriteGuardResult> {
  if (role !== 'owner' || !ownerId) return { ok: true };
  const sub = await resolveOwnerSubscription(ownerId);
  if (sub.status === 'locked') {
    const msg =
      sub.lockReason === 'revoked'
        ? 'Your management permissions have been revoked by an administrator. Contact support to restore access.'
        : 'Your subscription has lapsed. Renew your plan to continue managing your properties.';
    return { ok: false, status: 403, body: { error: msg, code: 'SUBSCRIPTION_LOCKED', lockReason: sub.lockReason } };
  }
  return { ok: true };
}

/**
 * Derive which of an owner's properties/tenants are "disabled" (over the effective
 * limit). Items are ranked oldest-first by created_at: the first `limit` stay active,
 * the newest excess are disabled. A tenant is disabled if it's beyond the tenant limit
 * OR its property is disabled (you can't manage a tenant in a disabled unit).
 * `-1` limit (unlimited) ⇒ nothing disabled.
 */
export async function getDisabledItemIds(
  ownerId: string,
  limits: { maxProperties: number; maxTenants: number }
): Promise<{ disabledPropertyIds: string[]; disabledTenantIds: string[] }> {
  // Properties (oldest first).
  const { data: props } = await supabaseAdminEngine
    .from('properties')
    .select('id')
    .eq('owner_id', ownerId)
    .order('created_at', { ascending: true });
  const propIds = (props || []).map((p) => p.id);
  const disabledPropertyIds =
    limits.maxProperties === -1 ? [] : propIds.slice(Math.max(0, limits.maxProperties));

  // Tenants (oldest first) scoped to the owner's properties.
  let disabledTenantIds: string[] = [];
  if (propIds.length) {
    const { data: tenants } = await supabaseAdminEngine
      .from('tenants')
      .select('id, property_id')
      .in('property_id', propIds)
      .order('created_at', { ascending: true });
    const list = tenants || [];
    const overTenantLimit =
      limits.maxTenants === -1 ? [] : list.slice(Math.max(0, limits.maxTenants)).map((t) => t.id);
    const disabledPropSet = new Set(disabledPropertyIds);
    const inDisabledProp = list.filter((t) => disabledPropSet.has(t.property_id)).map((t) => t.id);
    disabledTenantIds = Array.from(new Set([...overTenantLimit, ...inDisabledProp]));
  }

  return { disabledPropertyIds, disabledTenantIds };
}

/**
 * Gate a mutation that targets a specific property/tenant. No-op for non-owner callers.
 * Blocks (403 ITEM_DISABLED) when the target sits beyond the owner's current limit.
 */
export async function assertItemEnabled(
  role: string | null,
  ownerId: string | null,
  sub: OwnerSubscription,
  target: { propertyId?: string | null; tenantId?: string | null }
): Promise<WriteGuardResult> {
  if (role !== 'owner' || !ownerId) return { ok: true };
  // Unlimited on both axes ⇒ nothing can be disabled; skip the extra queries.
  if (sub.limits.maxProperties === -1 && sub.limits.maxTenants === -1) return { ok: true };

  const { disabledPropertyIds, disabledTenantIds } = await getDisabledItemIds(ownerId, sub.limits);
  const kindHit =
    (target.propertyId && disabledPropertyIds.includes(target.propertyId) && 'property') ||
    (target.tenantId && disabledTenantIds.includes(target.tenantId) && 'tenant') ||
    null;
  if (kindHit) {
    return {
      ok: false,
      status: 403,
      body: {
        error: `This ${kindHit} is disabled because it exceeds your ${sub.tierName} plan limit. Upgrade your plan to manage it.`,
        code: 'ITEM_DISABLED',
      },
    };
  }
  return { ok: true };
}

/**
 * Actual current usage counts for an owner — always counts (unlike checkCreateLimit,
 * which short-circuits to 0 on unlimited tiers). Use for display + downgrade checks.
 */
export async function countOwnerUsage(ownerId: string): Promise<{ properties: number; tenants: number }> {
  const { count: pCount } = await supabaseAdminEngine
    .from('properties')
    .select('id', { count: 'exact', head: true })
    .eq('owner_id', ownerId);
  const properties = pCount || 0;

  let tenants = 0;
  const { data: props } = await supabaseAdminEngine.from('properties').select('id').eq('owner_id', ownerId);
  const propertyIds = (props || []).map((p) => p.id);
  if (propertyIds.length) {
    const { count: tCount } = await supabaseAdminEngine
      .from('tenants')
      .select('id', { count: 'exact', head: true })
      .in('property_id', propertyIds);
    tenants = tCount || 0;
  }
  return { properties, tenants };
}

/**
 * Count an owner's current properties or tenants against their tier limit.
 * `-1` limit is unlimited (always allowed).
 */
export async function checkCreateLimit(
  kind: 'property' | 'tenant',
  ownerId: string,
  sub: OwnerSubscription
): Promise<{ allowed: boolean; current: number; limit: number }> {
  const limit = kind === 'property' ? sub.limits.maxProperties : sub.limits.maxTenants;
  if (limit === -1 || limit === null || limit === undefined) {
    return { allowed: true, current: 0, limit: -1 };
  }

  let current = 0;
  if (kind === 'property') {
    const { count } = await supabaseAdminEngine
      .from('properties')
      .select('id', { count: 'exact', head: true })
      .eq('owner_id', ownerId);
    current = count || 0;
  } else {
    // Tenants are scoped through the owner's properties (mirrors owners/[id] route).
    const { data: props } = await supabaseAdminEngine.from('properties').select('id').eq('owner_id', ownerId);
    const propertyIds = (props || []).map((p) => p.id);
    if (propertyIds.length) {
      const { count } = await supabaseAdminEngine
        .from('tenants')
        .select('id', { count: 'exact', head: true })
        .in('property_id', propertyIds);
      current = count || 0;
    }
  }

  return { allowed: current < limit, current, limit };
}
