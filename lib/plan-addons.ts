import { supabaseAdminEngine } from './supabase-server';
import { FeatureKey, FEATURE_KEYS, FEATURE_LABELS, TIER_COLUMN, FREE_TIER_ID } from './features';

// =====================================================================================
// PLAN-LEVEL ADD-ONS — which optional modules a subscription tier bundles.
//
// Two ways a module turns on for an owner (see lib/features.ts): the PLAN includes it
// (subscription_tiers.<module>_included, set here) or an ADMIN granted it to that one owner
// (owner_addons). This file is only about the first.
//
// Everything is driven off FEATURE_KEYS / TIER_COLUMN rather than naming columns, so adding a
// third paid module means touching lib/features.ts and nothing here.
// =====================================================================================

// NB: a flat result rather than a discriminated union — this project compiles with
// `strict: false`, where narrowing on an `ok: true | false` discriminant does not work.
// Same shape as parseTenure() in lib/payments/activate.ts, for the same reason.
export interface AddonParseResult {
  ok: boolean;
  keys: FeatureKey[];
  error?: string;
}

/** Validate an `addons: string[]` payload into known feature keys. */
export function parseAddons(raw: unknown): AddonParseResult {
  if (raw === undefined || raw === null) return { ok: true, keys: [] };
  if (!Array.isArray(raw)) return { ok: false, keys: [], error: 'addons must be a list of module keys.' };
  const keys: FeatureKey[] = [];
  for (const item of raw) {
    const key = String(item);
    if (!(FEATURE_KEYS as string[]).includes(key)) {
      return { ok: false, keys: [], error: `Unknown add-on module "${key}".` };
    }
    if (!keys.includes(key as FeatureKey)) keys.push(key as FeatureKey);
  }
  return { ok: true, keys };
}

/**
 * The `subscription_tiers` column updates for a selection.
 *
 * Every feature is written, not just the selected ones — otherwise unticking a module would
 * leave the old `true` in place and the plan would keep granting it.
 */
export function addonColumns(keys: FeatureKey[]): Record<string, boolean> {
  const cols: Record<string, boolean> = {};
  for (const key of FEATURE_KEYS) cols[TIER_COLUMN[key]] = keys.includes(key);
  return cols;
}

/** Which modules a tier row currently bundles. */
export function addonsOnTier(tier: Record<string, any> | null | undefined): FeatureKey[] {
  if (!tier) return [];
  return FEATURE_KEYS.filter((key) => !!tier[TIER_COLUMN[key]]);
}

/**
 * The Free baseline may never bundle a paid module — 'free_tier' is also the sentinel tierId
 * resolveOwnerSubscription returns for an owner with no plan row at all, so a module bundled
 * there would reach every planless owner. tierIncludes() already refuses it at read time; this
 * refuses it at write time so the admin gets told instead of saving a flag that does nothing.
 */
export function rejectAddonsOnFreeTier(tierId: string, keys: FeatureKey[]): string | null {
  if (tierId !== FREE_TIER_ID || keys.length === 0) return null;
  return 'The Free plan cannot include paid modules — it is also the fallback for owners with no plan, '
    + 'so anything bundled here would reach every one of them. Grant the module to individual owners instead.';
}

/**
 * How many owners would LOSE a module if these keys were removed from `tierId`.
 *
 * Counts owners whose newest subscription_history row is this tier, excluding anyone holding
 * their own enabled owner_addons grant for that module — their access survives the change, so
 * warning about them would be wrong.
 *
 * Returns {} when nothing is affected. Never throws: a failed count must not block the edit,
 * it only means the admin doesn't get a warning.
 */
export async function countOwnersLosingAddons(
  tierId: string,
  removed: FeatureKey[]
): Promise<Record<string, number>> {
  const affected: Record<string, number> = {};
  if (!removed.length) return affected;

  try {
    // Newest history row per owner — same approach as /api/super-admin/owners.
    const { data: subs, error } = await supabaseAdminEngine
      .from('subscription_history')
      .select('owner_id, tier_id, status, created_at')
      .order('created_at', { ascending: false });
    if (error) throw error;

    const latest: Record<string, { tier_id: string; status: string }> = {};
    for (const s of subs || []) if (!latest[s.owner_id]) latest[s.owner_id] = s;

    const ownersOnTier = Object.entries(latest)
      .filter(([, s]) => s.tier_id === tierId && s.status !== 'canceled')
      .map(([ownerId]) => ownerId);
    if (!ownersOnTier.length) return affected;

    // Personal grants that would keep the module on regardless of the plan.
    const { data: grants } = await supabaseAdminEngine
      .from('owner_addons')
      .select('owner_id, addon_key')
      .eq('enabled', true)
      .in('owner_id', ownersOnTier);
    const granted = new Set((grants || []).map((g) => `${g.owner_id}|${g.addon_key}`));

    for (const key of removed) {
      const losing = ownersOnTier.filter((id) => !granted.has(`${id}|${key}`)).length;
      if (losing > 0) affected[key] = losing;
    }
  } catch (err) {
    console.error('[plan-addons] could not count affected owners; saving without a warning:', err);
    return {};
  }
  return affected;
}

/**
 * Which of `row`'s columns a PostgREST "column not found" error is complaining about.
 *
 * PostgREST reports one missing column at a time (PGRST204 / 42703) and names it in the
 * message, e.g. `Could not find the 'staff_included' column of 'subscription_tiers'`. We match
 * against the keys we actually tried to write so an unrelated column name in the text can never
 * cause us to silently drop a field the caller set.
 */
export function missingColumnFrom(message: string | undefined, row: Record<string, unknown>): string[] {
  if (!message) return [];
  return Object.keys(row).filter((col) => new RegExp(`\\b${col}\\b`).test(message));
}

/** "Staff management (3 owners)" — the human summary for the confirm prompt. */
export function describeAffected(affected: Record<string, number>): string {
  return Object.entries(affected)
    .map(([key, n]) => `${FEATURE_LABELS[key as FeatureKey] || key} (${n} owner${n === 1 ? '' : 's'})`)
    .join(', ');
}
