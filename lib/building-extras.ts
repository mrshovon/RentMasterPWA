import { supabaseAdminEngine } from './supabase-server';

// =====================================================================================
// 🏢 BUILDING CONFIG LISTS — amenities and income sources.
//
// Two near-identical CRUD surfaces, so the shared shape lives here rather than being written
// twice (and drifting once). See ADD_BUILDING_EXTRAS.sql for why these hold DEFINITIONS only —
// the money itself stays in account_transactions.
//
// Lives in lib/ because Next.js only allows HTTP handlers to be exported from a route.ts.
// =====================================================================================

export const AMENITY_SELECT =
  'id, building_id, name, description, monthly_cost, is_active, created_at, updated_at';

export const INCOME_SOURCE_SELECT =
  'id, building_id, name, category, default_amount, note, is_active, created_at, updated_at';

export class BuildingExtraFieldError extends Error {}

function trimmed(value: unknown, max: number): string | null {
  const s = String(value ?? '').trim();
  return s ? s.slice(0, max) : null;
}

function money(value: unknown, field: string): number {
  const n = Number(value ?? 0);
  if (!Number.isFinite(n) || n < 0) {
    throw new BuildingExtraFieldError(`${field} must be a positive amount.`);
  }
  return n;
}

/**
 * Normalise an amenity body. Returns ONLY the keys actually present, so a PATCH stays partial —
 * sending `{ isActive: false }` must not blank the description as a side effect.
 * `requireName` is set on create, where a nameless row is meaningless.
 */
export function amenityFieldsFrom(
  body: Record<string, unknown>,
  requireName = false
): Record<string, unknown> {
  const out: Record<string, unknown> = {};

  if (body.name !== undefined || requireName) {
    const name = trimmed(body.name, 200);
    if (!name) throw new BuildingExtraFieldError('The amenity needs a name.');
    out.name = name;
  }
  if (body.description !== undefined) out.description = trimmed(body.description, 1000);
  if (body.monthlyCost !== undefined) out.monthly_cost = money(body.monthlyCost, 'The monthly cost');
  if (body.isActive !== undefined) out.is_active = !!body.isActive;

  if (Object.keys(out).length) out.updated_at = new Date().toISOString();
  return out;
}

/** The same, for an income source. */
export function incomeSourceFieldsFrom(
  body: Record<string, unknown>,
  requireName = false
): Record<string, unknown> {
  const out: Record<string, unknown> = {};

  if (body.name !== undefined || requireName) {
    const name = trimmed(body.name, 200);
    if (!name) throw new BuildingExtraFieldError('The income source needs a name.');
    out.name = name;
  }
  if (body.category !== undefined) out.category = trimmed(body.category, 120);
  if (body.defaultAmount !== undefined) out.default_amount = money(body.defaultAmount, 'The amount');
  if (body.note !== undefined) out.note = trimmed(body.note, 1000);
  if (body.isActive !== undefined) out.is_active = !!body.isActive;

  if (Object.keys(out).length) out.updated_at = new Date().toISOString();
  return out;
}

/** Confirm a row exists AND belongs to this building, so a foreign id reads as "not found". */
export async function ownedBuildingExtra(
  table: 'building_amenities' | 'building_income_sources',
  id: string,
  buildingId: string
) {
  const { data } = await supabaseAdminEngine
    .from(table)
    .select('id')
    .eq('id', id)
    .eq('building_id', buildingId)
    .maybeSingle();
  return data;
}
