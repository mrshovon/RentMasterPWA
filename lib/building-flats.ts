// =====================================================================================
// 🏢 BUILDING FLATS — one owner, several flats, one login.
//
// A flat owner can hold more than one flat. building_owners stays ONE ROW PER PERSON — that PK is
// the index buildingMembershipOf() uses on every plan resolution, and a second row under its
// .maybeSingle() would resolve the owner to the FREE plan and cache it. So the flats live here, in
// a child table the plan path never learns about. The full argument is in
// ADD_BUILDING_OWNER_FLATS.sql; do not re-derive it, and do not move flats onto building_owners.
//
// This module owns the two things every flats caller needs: parsing a flats array off a request
// body, and inserting flats together with the rentable unit behind each one.
// =====================================================================================

import { supabaseAdminEngine } from './supabase-server';
import { flatToken } from './validate';
import { createFlatProperty } from './properties';
import { BUILDING_FLAT_SELECT, type BuildingOwnerFlat, type BuildingRow } from './building';

/** How many flats one owner may hold. A sanity bound, not a business rule. */
export const MAX_FLATS_PER_OWNER = 40;

export interface FlatInput {
  unitLabel: string;
  defaultServiceCharge: number;
  /** Create the rentable unit behind this flat. Default true — it is the point of the feature. */
  createProperty: boolean;
}

function oneFlat(raw: any): FlatInput {
  return {
    unitLabel: String(raw?.unitLabel ?? raw?.flatNo ?? '').trim().slice(0, 120),
    defaultServiceCharge: Number(raw?.defaultServiceCharge || 0) || 0,
    createProperty: raw?.createProperty !== false,
  };
}

/**
 * The flats named on a request body, in the order the admin listed them.
 *
 * Accepts the new `flats: [...]` shape, and falls back to synthesising a one-element array from the
 * old scalar `flatNo` / `unitLabel` / `defaultServiceCharge` body — so the previous API contract
 * still works and nothing external had to change on the day this shipped.
 *
 * Throws a message meant for the admin; callers turn it into a 400.
 */
export function readFlatsFromBody(
  body: any,
  opts: { requireFlat: boolean },
): FlatInput[] {
  const raw = Array.isArray(body?.flats) && body.flats.length
    ? body.flats
    : [{ unitLabel: body?.flatNo ?? body?.unitLabel, defaultServiceCharge: body?.defaultServiceCharge }];

  const flats = raw.map(oneFlat);

  if (flats.length > MAX_FLATS_PER_OWNER) {
    throw new Error(`One owner can hold at most ${MAX_FLATS_PER_OWNER} flats.`);
  }
  // On a building that issues logins the first flat feeds the identifier, so it cannot be blank.
  // On a legacy building taking typed emails the label stays optional, exactly as it was.
  if (opts.requireFlat && !flats[0].unitLabel) {
    throw new Error('The first flat needs a number — the login is built from it.');
  }
  if (flats.some((f: FlatInput, i: number) => i > 0 && !f.unitLabel)) {
    throw new Error('Every flat needs a number.');
  }

  // Two rows for the same flat under ONE owner is a typo, not a co-ownership: co-owners are two
  // different people, two roster rows and two flat rows (ADD_BUILDING_LOGIN_IDS.sql:44-49).
  const seen = new Set<string>();
  for (const f of flats) {
    const key = flatToken(f.unitLabel) || f.unitLabel.toLowerCase();
    if (key && seen.has(key)) throw new Error(`${f.unitLabel} is listed twice.`);
    seen.add(key);
  }

  return flats;
}

/**
 * Insert flats for one owner, each with its rentable unit.
 *
 * THROWS if the flat rows cannot be written — an owner on the roster with no flats is billed for
 * nothing, silently, which is worse than a failed create the admin can retry.
 * DOES NOT THROW if a property cannot be created: that comes back in `warnings`, and the flat is
 * still a perfectly good flat. See createFlatProperty().
 */
export async function insertOwnerFlats(opts: {
  buildingId: string;
  ownerId: string;
  ownerPhone: string | null;
  building: BuildingRow;
  flats: FlatInput[];
  /** True when this owner has no flats yet, so the first one becomes their primary. */
  firstIsPrimary: boolean;
}): Promise<{ flats: BuildingOwnerFlat[]; warnings: string[] }> {
  const warnings: string[] = [];

  const rows = await Promise.all(
    opts.flats.map(async (f, i) => {
      let propertyId: string | null = null;
      if (f.createProperty) {
        propertyId = await createFlatProperty({
          ownerId: opts.ownerId,
          ownerPhone: opts.ownerPhone,
          buildingName: opts.building.name,
          buildingAddress: [opts.building.address, opts.building.city].filter(Boolean).join(', '),
          unitLabel: f.unitLabel,
        });
        if (!propertyId) {
          warnings.push(
            `${f.unitLabel || 'The flat'} was added, but its property could not be created. The owner can add it themselves from their dashboard.`,
          );
        }
      }
      return {
        id: crypto.randomUUID(),
        building_id: opts.buildingId,
        owner_id: opts.ownerId,
        unit_label: f.unitLabel || null,
        flat_no: flatToken(f.unitLabel) || null,
        default_service_charge: f.defaultServiceCharge,
        is_primary: opts.firstIsPrimary && i === 0,
        property_id: propertyId,
      };
    }),
  );

  const { data, error } = await supabaseAdminEngine
    .from('building_owner_flats')
    .insert(rows)
    .select(BUILDING_FLAT_SELECT);

  if (error) throw error;
  return { flats: (data || []) as unknown as BuildingOwnerFlat[], warnings };
}

/**
 * Group flats by owner for a roster payload. One query for the whole building, grouped in memory —
 * enrichRoster() is already N auth lookups, and a per-owner flats query would make that N+N.
 */
export function groupFlatsByOwner(flats: BuildingOwnerFlat[]): Record<string, BuildingOwnerFlat[]> {
  const out: Record<string, BuildingOwnerFlat[]> = {};
  for (const f of flats) {
    (out[f.owner_id] ||= []).push(f);
  }
  return out;
}
