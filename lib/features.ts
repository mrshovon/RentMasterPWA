import { supabaseAdminEngine } from './supabase-server';
import { resolveOwnerSubscription, type WriteGuardResult } from './subscription';

// =====================================================================================
// 🔐 PAID FEATURE GATING — which optional modules an owner may use.
//
// Two independent ways a feature turns on:
//   1. THE PLAN INCLUDES IT — subscription_tiers.staff_included (true for the Whole Building
//      / 'custom' tiers). Editable from the admin console, so adding a tier that bundles a
//      feature never needs a code change.
//   2. AN ADMIN GRANTED IT — an owner_addons row (the owner bought the add-on). This grant is
//      ABSOLUTE: it applies on any tier, free included, so trials and special cases work.
//
// The grant deliberately lives in a table, NOT in auth user_metadata where permissions_revoked
// sits — user_metadata is writable by the user themselves, so a paid flag there is self-grantable.
// See ADD_STAFF.sql.
//
// Kept generic (FeatureKey) so the next paid module drops in without reshaping any of this.
// =====================================================================================

export type FeatureKey = 'staff' | 'accounts';

export const FEATURE_KEYS: FeatureKey[] = ['staff', 'accounts'];

// Human-facing names, used in the 403 message the UI surfaces.
const FEATURE_LABELS: Record<FeatureKey, string> = {
  staff: 'Staff management',
  accounts: 'Accounts & bookkeeping',
};

// Which subscription_tiers column bundles each feature into a plan. A column per feature keeps
// "which plans include X" editable from the admin console without a code change.
const TIER_COLUMN: Record<FeatureKey, string> = {
  staff: 'staff_included',
  accounts: 'accounts_included',
};

export interface FeatureState {
  enabled: boolean;
  /** Why it's on: bundled with the plan, or granted as an add-on. null when off. */
  source: 'plan' | 'addon' | null;
}

export type FeatureMap = Record<FeatureKey, FeatureState>;

const OFF: FeatureState = { enabled: false, source: null };

/**
 * Does this tier bundle the given feature (via its subscription_tiers.<col> flag)?
 *
 * Queried here rather than joined into resolveOwnerSubscription on purpose: that function
 * ignores query errors and falls back to a Free state when it gets no row, so selecting a
 * column that doesn't exist yet would silently downgrade every paid owner to Free limits in
 * the window between deploying this code and running the migration. Keeping the dependency on
 * the new column isolated in here means a pre-migration failure only turns the feature off.
 */
async function tierIncludes(tierId: string | null, column: string): Promise<boolean> {
  // 'free_tier' is both the sentinel resolveOwnerSubscription uses for a planless owner AND the
  // real free tier's id, so short-circuiting it costs nothing and enforces "the free tier never
  // bundles a paid module" outright. An admin can still grant it per-owner via owner_addons.
  if (!tierId || tierId === 'free_tier') return false;
  const { data, error } = await supabaseAdminEngine
    .from('subscription_tiers')
    .select(column)
    .eq('id', tierId)
    .maybeSingle();
  if (error) {
    console.error(`[features] subscription_tiers.${column} lookup failed:`, error.message);
    return false;
  }
  return !!(data as any)?.[column];
}

/** Every enabled add-on key for an owner. Missing table/row => empty set (feature simply off). */
async function loadAddonKeys(ownerId: string): Promise<Set<string>> {
  const { data, error } = await supabaseAdminEngine
    .from('owner_addons')
    .select('addon_key')
    .eq('owner_id', ownerId)
    .eq('enabled', true);
  if (error) {
    // Never hard-fail a request because the add-on lookup broke: degrade to "no add-ons".
    console.error('[features] owner_addons lookup failed:', error.message);
    return new Set();
  }
  return new Set((data || []).map((r) => r.addon_key));
}

/**
 * Resolve every optional feature for an owner. Never throws — an owner with no plan and no
 * add-on row resolves to everything off.
 */
export async function resolveOwnerFeatures(ownerId: string): Promise<FeatureMap> {
  const [sub, addonKeys] = await Promise.all([
    resolveOwnerSubscription(ownerId),
    loadAddonKeys(ownerId),
  ]);
  // Whether each feature is bundled with the plan (one isolated, error-tolerant lookup per feature).
  const inPlan = await Promise.all(
    FEATURE_KEYS.map((key) => tierIncludes(sub.tierId, TIER_COLUMN[key]))
  );

  const resolve = (key: FeatureKey, includedInPlan: boolean): FeatureState => {
    if (includedInPlan) return { enabled: true, source: 'plan' };
    if (addonKeys.has(key)) return { enabled: true, source: 'addon' };
    return { ...OFF };
  };

  return FEATURE_KEYS.reduce((map, key, i) => {
    map[key] = resolve(key, inPlan[i]);
    return map;
  }, {} as FeatureMap);
}

/** Resolve a single feature. */
export async function resolveFeature(ownerId: string, key: FeatureKey): Promise<FeatureState> {
  const map = await resolveOwnerFeatures(ownerId);
  return map[key] ?? { ...OFF };
}

/**
 * Gate a route on a paid feature. No-op (ok) for any caller whose role is not 'owner', mirroring
 * assertOwnerCanWrite — tenants and admins are never blocked by an owner's add-ons.
 *
 * Apply this to READS as well as writes: hiding a tab in the UI is not a gate.
 */
export async function assertFeature(
  role: string | null,
  ownerId: string | null,
  key: FeatureKey
): Promise<WriteGuardResult> {
  if (role !== 'owner' || !ownerId) return { ok: true };
  const state = await resolveFeature(ownerId, key);
  if (state.enabled) return { ok: true };
  return {
    ok: false,
    status: 403,
    body: {
      error: `${FEATURE_LABELS[key]} is not enabled on your account. It's included with the Whole Building plan, or can be added to your current plan — contact us to enable it.`,
      code: 'FEATURE_NOT_ENABLED',
    },
  };
}
