import { supabaseAdminEngine } from './supabase-server';
import { buildingMembershipOf, BUILDING_ADMIN_ROLE } from './building';

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

// The tierId freeState() stamps on a planless owner. Declared here rather than imported from
// lib/features.ts (FREE_TIER_ID) because features.ts imports this file — a cycle would leave one
// of them half-initialised at module load. Same string, two homes, on purpose.
const FREE_TIER_SENTINEL = 'free_tier';

// Which roles a plan can actually gate. Tenants and super admins are never blocked by a plan;
// owners and building admins both are, each on their own subscription. Exported so a route can
// answer "is this caller plan-governed?" without re-deriving the list.
export const PLAN_GOVERNED_ROLES: string[] = ['owner', BUILDING_ADMIN_ROLE];

function isPlanGoverned(role: string | null): boolean {
  return !!role && PLAN_GOVERNED_ROLES.includes(role);
}

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
  /**
   * Set when a paid plan ran out and this owner has been dropped to Free. Null the rest of the
   * time, including while they are still in grace. The UI reads it to say WHICH plan ended
   * instead of a bare "you're on the free plan", and the subscriptions cron uses it to decide
   * that a downgrade notification is due.
   */
  downgradedFrom: { tierId: string; tierName: string; endedAt: string | null } | null;
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

/**
 * A one-time plan (a trial): the owner may take it once, then must choose another.
 *
 * `=== false`, not `!== true`: before ADD_PLAN_RECURRING.sql runs the field is undefined and
 * every plan must stay renewable exactly as before. Same convention as `is_public`.
 */
export function tierIsOneTime(tier: any): boolean {
  return tier?.is_recurring === false;
}

/**
 * Every tier this owner has ever been on. "Already used a one-time plan" is just "has a
 * subscription_history row for it" — no extra bookkeeping table needed.
 *
 * Returns an empty set on failure rather than throwing: a lookup blip must not block an owner
 * from activating a plan they are entitled to.
 */
export async function ownerUsedTierIds(ownerId: string): Promise<Set<string>> {
  const { data, error } = await supabaseAdminEngine
    .from('subscription_history')
    .select('tier_id')
    .eq('owner_id', ownerId);
  if (error) {
    console.error('[subscription] used-tier lookup failed:', error.message);
    return new Set();
  }
  return new Set((data || []).map((r: { tier_id: string }) => r.tier_id).filter(Boolean));
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

function freeState(
  limits: { maxProperties: number; maxTenants: number },
  revoked: boolean,
  downgradedFrom: OwnerSubscription['downgradedFrom'] = null,
): OwnerSubscription {
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
    downgradedFrom,
  };
}

/**
 * Resolve an account's OWN subscription state, ignoring any building it belongs to.
 * Never throws for "no plan" — a planless owner resolves to a perpetual Free state.
 *
 * Private: everything outside this file calls resolveOwnerSubscription() below, which layers
 * the Whole Building substitution on top. Keeping this one separate is also what makes the
 * substitution non-recursive — it resolves the building admin through THIS function.
 */
async function resolveOwnSubscription(ownerId: string): Promise<OwnerSubscription> {
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

  // A finished ONE-TIME plan (a trial) drops the owner to Free rather than into grace and then
  // lock. A trial is priced 0 but carries an explicit duration_days, which tierIsFree() excludes,
  // so without this it would run the full paid lifecycle and lock out every trial user who did
  // not convert — ten days after their trial ended, for a plan they never paid for.
  //
  // Resolved here at read time rather than by a cron, so it is correct the moment the trial
  // lapses. They keep working, capped by the Free limits, which is still real pressure to buy.
  if (tierIsOneTime(tier) && now >= end) {
    return freeState(await loadFreeLimits(), permissionsRevoked);
  }

  // An admin revoke is a hard lock and outranks everything below — it is a deliberate act against
  // this specific account, not the ordinary end of a billing period, and it must not be softened
  // into "you're on the free plan now".
  if (permissionsRevoked) {
    return {
      tierId: tier.id,
      tierName: tier.name || tier.id,
      interval: tier.billing_interval || 'month',
      price: Number(tier.price || 0),
      isFree: false,
      status: 'locked',
      expiryDate: endRaw || null,
      daysUntilExpiry: Math.ceil((end - now) / DAY_MS),
      graceEndsAt: new Date(graceEnd).toISOString(),
      daysLeftInGrace: null,
      warnExpiringSoon: false,
      limits,
      permissionsRevoked: true,
      lockReason: 'revoked',
      downgradedFrom: null,
    };
  }

  // GRACE IS OVER ⇒ DROP TO FREE, rather than locking on the old tier forever.
  //
  // This used to end in `status: 'locked'` with the paid tier's limits still attached, which had
  // two problems. The owner was fully walled out — every write 403'd — so "renew to continue" was
  // a demand rather than an offer; and they were nominally still on a plan they had stopped
  // paying for, which is why nothing in the app could ever say "you have been downgraded".
  //
  // Now they land on the Free baseline: 2 properties, 2 tenants, add-ons off (lib/features.ts
  // never bundles anything on free_tier). Nothing is deleted — getDisabledItemIds() greys out
  // everything past the limit as read-only, which is machinery that already existed for exactly
  // this shape of problem. They keep working at a reduced level, and the pressure to buy comes
  // from seeing their own data go quiet rather than from a wall.
  //
  // Resolved at READ time, like the one-time-trial fallback above, so it is correct the moment
  // grace lapses even if the notification cron never runs.
  if (now >= graceEnd) {
    return freeState(await loadFreeLimits(), false, {
      tierId: tier.id,
      tierName: tier.name || tier.id,
      endedAt: endRaw || null,
    });
  }

  let status: OwnerSubscription['status'];
  let lockReason: OwnerSubscription['lockReason'] = null;
  if (now < end) {
    status = 'active';
  } else {
    status = 'grace';
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
    downgradedFrom: null, // still on the plan — grace is not a downgrade
  };
}

/**
 * Resolve the effective subscription state for an owner, including the Whole Building plan
 * they may sit under.
 *
 * A flat owner created by a building admin has no subscription_history row of their own — the
 * building admin is the billing party. So when (and ONLY when) an owner's own resolution comes
 * back genuinely planless, their building's plan is substituted in.
 *
 * Three rules this encodes, all deliberate:
 *   * An owner's OWN paid plan always wins. Money already taken is never silently overridden,
 *     and it keeps "attach an existing paying owner to a building" non-destructive.
 *   * tierId is NOT rewritten. resolveOwnerFeatures() looks the tier id up in subscription_tiers
 *     to decide which modules are bundled, so relabelling it here would quietly switch them off.
 *     Only tierName carries the building's name.
 *   * The member's own permissions_revoked is OR-ed in. Dropping it would make the super admin's
 *     only hard lock over that individual account stop working.
 *
 * Every failure path returns the owner's own resolution unchanged, so before ADD_BUILDINGS.sql
 * has run — or if the lookup errors for any reason at all — behaviour is byte-identical to
 * what it was before this feature existed.
 */
export async function resolveOwnerSubscription(ownerId: string): Promise<OwnerSubscription> {
  const own = await resolveOwnSubscription(ownerId);

  // Only a genuinely planless owner is a candidate. A paid plan, a trial, a grace or a
  // downgraded state all mean this owner's plan is their own business.
  if (!own.isFree || own.tierId !== FREE_TIER_SENTINEL) return own;

  try {
    const membership = await buildingMembershipOf(ownerId);
    if (!membership) return own;

    const buildingPlan = await resolveOwnSubscription(membership.adminId);
    const revoked = own.permissionsRevoked || buildingPlan.permissionsRevoked;

    return {
      ...buildingPlan,
      tierName: `${buildingPlan.tierName} — ${membership.buildingName}`,
      permissionsRevoked: revoked,
      status: revoked ? 'locked' : buildingPlan.status,
      lockReason: revoked ? buildingPlan.lockReason || 'revoked' : buildingPlan.lockReason,
    };
  } catch {
    // A missing table, a PostgREST error, anything: fall back to what the owner resolved alone.
    return own;
  }
}

export interface WriteGuardResult {
  ok: boolean;
  status?: number;
  body?: { error: string; code: string; lockReason?: string | null };
}

/**
 * Gate an owner "write/task" action on subscription state. No-op (ok) for any caller whose role
 * is not plan-governed (tenants + super admins are never blocked by a plan).
 *
 * A building admin IS plan-governed, on their own Whole Building subscription. Leaving them out
 * would have been the worst bug in this feature: they reuse every owner route, so an unrecognised
 * role here would wave them straight past the lock on all of them.
 */
export async function assertOwnerCanWrite(role: string | null, ownerId: string | null): Promise<WriteGuardResult> {
  if (!isPlanGoverned(role) || !ownerId) return { ok: true };
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
 * Gate a mutation that targets a specific property/tenant. No-op for callers whose role is not
 * plan-governed. Blocks (403 ITEM_DISABLED) when the target sits beyond the caller's limit.
 */
export async function assertItemEnabled(
  role: string | null,
  ownerId: string | null,
  sub: OwnerSubscription,
  target: { propertyId?: string | null; tenantId?: string | null }
): Promise<WriteGuardResult> {
  if (!isPlanGoverned(role) || !ownerId) return { ok: true };
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
