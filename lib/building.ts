import type { NextRequest } from 'next/server';
import { supabaseAdminEngine } from './supabase-server';

// =====================================================================================
// 🏢 WHOLE BUILDING — the building admin role and the building/owner roster.
//
// The hierarchy: super admin -> building admin -> owner -> tenant. A building admin owns one
// building, creates the flat owners under it, and is the billing party for the Whole Building
// plan. See ADD_BUILDINGS.sql for the schema and why neither uid column is a foreign key.
//
// ⚠️ THE RULE THIS FILE EXISTS TO ENFORCE: `/api/admin/*` is AUTHENTICATED, not AUTHORIZED.
// middleware.ts checks a role only for `/api/super-admin/*`; every other gated path accepts any
// valid bearer token, tenant tokens included. So every building route must call
// requireBuildingAdmin() as its FIRST line. Putting the routes under /api/admin/building/ buys
// identity injection, header anti-spoof, CORS and rate limiting — it buys nothing about *who*.
//
// This module must NOT import ./subscription — subscription.ts imports buildingMembershipOf()
// from here, and a cycle would leave one of them half-initialised at module load.
// =====================================================================================

export const BUILDING_ADMIN_ROLE = 'building_admin';

/**
 * The subscription_tiers row a building admin is put on. It is a "contact us" tier
 * (billing_interval 'custom', price 0, limits -1/-1), which means tierIsFree() is true for it —
 * so it resolves perpetual and unlimited and can never expire, grace or lock. Only an admin
 * revoke locks it. That is intended: the building's commercial arrangement is handled offline.
 */
export const WHOLE_BUILDING_TIER_ID = 'whole_building';

/**
 * The route-guard shape used by assertOwnerCanWrite / assertFeature. Re-declared rather than
 * imported from ./subscription to keep this module free of that dependency.
 */
export interface BuildingGuardResult {
  ok: boolean;
  status?: number;
  body?: { error: string; code: string };
}

export interface BuildingRow {
  id: string;
  building_no?: number;
  admin_id: string;
  name: string;
  /** Street/holding number as a human writes it ("12/A"). Null on a building that predates
   * system login identifiers, which is what keeps its owners on the typed-email path. */
  house_no: string | null;
  address: string | null;
  city: string | null;
  letterhead_url: string | null;
  signatory_name: string | null;
  signatory_title: string | null;
  notes: string | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface BuildingMembership {
  buildingId: string;
  buildingName: string;
  adminId: string;
  unitLabel: string | null;
  defaultServiceCharge: number;
}

export const BUILDING_SELECT =
  'id, building_no, admin_id, name, house_no, address, city, letterhead_url, signatory_name, signatory_title, notes, is_active, created_at, updated_at';

export const BUILDING_OWNER_SELECT =
  'building_id, owner_id, unit_label, flat_no, default_service_charge, joined_at, is_active, created_at, updated_at';

/**
 * One flat an owner holds in a building. An owner may hold several; building_owners stays one row
 * per person (see ADD_BUILDING_OWNER_FLATS.sql for why that separation is load-bearing).
 */
export interface BuildingOwnerFlat {
  id: string;
  building_id: string;
  owner_id: string;
  unit_label: string | null;
  flat_no: string | null;
  default_service_charge: number;
  is_primary: boolean;
  /** properties.id — TEXT, not uuid. The base schema was built by hand. */
  property_id: string | null;
  is_active: boolean;
  joined_at: string;
  created_at: string;
  updated_at: string;
}

export const BUILDING_FLAT_SELECT =
  'id, building_id, owner_id, unit_label, flat_no, default_service_charge, is_primary, property_id, joined_at, is_active, created_at, updated_at';

export function isBuildingAdmin(role: string | null | undefined): boolean {
  return role === BUILDING_ADMIN_ROLE;
}

/** The caller's auth uid, as injected by middleware. Mirrors ownerId() in the other lib modules. */
export function buildingAdminUid(request: NextRequest): string | null {
  const id = request.headers.get('x-rentmaster-uid');
  if (!id || id === 'YOUR_ACTUAL_USER_UUID_FROM_DATABASE') return null;
  return id;
}

/**
 * First line of every /api/admin/building/* handler. Resolves the caller's building, or returns
 * the 403/404 to send back. A tenant token carries no x-rentmaster-uid at all, so it fails on
 * the uid check before the role check even runs.
 */
export async function requireBuildingAdmin(
  request: NextRequest
): Promise<BuildingGuardResult & { uid?: string; building?: BuildingRow }> {
  const uid = buildingAdminUid(request);
  const role = request.headers.get('x-rentmaster-role');

  if (!uid || !isBuildingAdmin(role)) {
    return {
      ok: false,
      status: 403,
      body: { error: 'This area is for building administrators only.', code: 'NOT_BUILDING_ADMIN' },
    };
  }

  const building = await ownedBuilding(uid);
  if (!building) {
    return {
      ok: false,
      status: 404,
      body: {
        error: 'No building is set up for this account yet. Contact support to have one created.',
        code: 'NO_BUILDING',
      },
    };
  }

  return { ok: true, uid, building };
}

/**
 * The building this admin owns, or null. Returns null on any error — a missing table before
 * ADD_BUILDINGS.sql has run must read as "no building", never as a 500.
 */
export async function ownedBuilding(adminId: string): Promise<BuildingRow | null> {
  try {
    const { data, error } = await supabaseAdminEngine
      .from('buildings')
      .select(BUILDING_SELECT)
      .eq('admin_id', adminId)
      .maybeSingle();
    if (error) return null;
    return (data as BuildingRow) || null;
  } catch {
    return null;
  }
}

// -------------------------------------------------------------------------------------
// Membership lookup — the hot path.
//
// resolveOwnerSubscription() calls this for every planless owner, and that runs 2-3 times in a
// single billing write. The result changes only when an admin adds or detaches an owner, so a
// short TTL cache is safe: the worst case is a minute of stale plan labelling. The map is
// per serverless instance, which is short-lived anyway.
// -------------------------------------------------------------------------------------
const MEMBERSHIP_TTL_MS = 60_000;
const membershipCache = new Map<string, { value: BuildingMembership | null; at: number }>();

/**
 * Which building this owner belongs to, or null. NEVER throws and never surfaces an error:
 * a missing table, a PostgREST PGRST205, a network blip — all read as "not in a building",
 * which leaves every existing owner's plan resolution byte-identical to before this feature.
 */
export async function buildingMembershipOf(ownerId: string): Promise<BuildingMembership | null> {
  if (!ownerId) return null;

  const hit = membershipCache.get(ownerId);
  if (hit && Date.now() - hit.at < MEMBERSHIP_TTL_MS) return hit.value;

  let value: BuildingMembership | null = null;
  let failed = false;
  try {
    const { data, error } = await supabaseAdminEngine
      .from('building_owners')
      .select(
        'building_id, unit_label, default_service_charge, is_active, buildings:building_id ( id, name, admin_id, is_active )'
      )
      .eq('owner_id', ownerId)
      .eq('is_active', true)
      .maybeSingle();

    if (error) failed = true;
    const building = (data as any)?.buildings;
    if (!error && data && building && building.is_active !== false) {
      value = {
        buildingId: String(building.id),
        buildingName: String(building.name || 'Building'),
        adminId: String(building.admin_id),
        unitLabel: (data as any).unit_label ?? null,
        defaultServiceCharge: Number((data as any).default_service_charge || 0),
      };
    }
  } catch {
    value = null;
    failed = true;
  }

  // Cache a genuine "not in a building" for the TTL, but NEVER cache a failure. The two are
  // indistinguishable in `value` — both are null — and caching the second one pins the owner to
  // the FREE plan for a full minute over a transient blip, with their excess properties going
  // view-only and Staff/Accounts switching off. A retry costs one query.
  if (!failed) {
    membershipCache.set(ownerId, { value, at: Date.now() });
    if (membershipCache.size > 5000) membershipCache.clear();
  }
  return value;
}

/**
 * The flats one owner holds, newest last. Separately cached from membershipCache and
 * deliberately NOT called from buildingMembershipOf() or anything the plan-resolution path
 * reaches — that separation is the whole reason flats live in a child table. See
 * ADD_BUILDING_OWNER_FLATS.sql.
 *
 * Unlike buildingMembershipOf() this one THROWS on a real error rather than reading as "no
 * flats". An empty list here means "this owner is billed for nothing", which is a sentence the
 * generate-a-month run would act on; a missing table must not be able to say it.
 */
export async function flatsOfOwner(
  ownerId: string,
  activeOnly = true,
): Promise<BuildingOwnerFlat[]> {
  if (!ownerId) return [];
  let q = supabaseAdminEngine
    .from('building_owner_flats')
    .select(BUILDING_FLAT_SELECT)
    .eq('owner_id', ownerId)
    .order('created_at', { ascending: true });
  if (activeOnly) q = q.eq('is_active', true);
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  return (data || []) as unknown as BuildingOwnerFlat[];
}

/** Every flat on a building's roster. The generate-a-month enumeration. Throws, for the same reason. */
export async function buildingFlats(
  buildingId: string,
  activeOnly = true,
): Promise<BuildingOwnerFlat[]> {
  let q = supabaseAdminEngine
    .from('building_owner_flats')
    .select(BUILDING_FLAT_SELECT)
    .eq('building_id', buildingId)
    .order('created_at', { ascending: true });
  if (activeOnly) q = q.eq('is_active', true);
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  return (data || []) as unknown as BuildingOwnerFlat[];
}

/** One flat, scoped to its building so a guessed id reads as not-found. */
export async function flatInBuilding(
  buildingId: string,
  flatId: string,
): Promise<BuildingOwnerFlat | null> {
  const { data, error } = await supabaseAdminEngine
    .from('building_owner_flats')
    .select(BUILDING_FLAT_SELECT)
    .eq('building_id', buildingId)
    .eq('id', flatId)
    .maybeSingle();
  if (error || !data) return null;
  return data as unknown as BuildingOwnerFlat;
}

/** Drop a cached membership after attaching/detaching, so the change shows immediately. */
export function forgetBuildingMembership(ownerId: string): void {
  membershipCache.delete(ownerId);
}

/** Is this owner on this building's roster? Used to scope every per-owner building route. */
export async function ownerInBuilding(buildingId: string, ownerId: string): Promise<boolean> {
  try {
    const { data, error } = await supabaseAdminEngine
      .from('building_owners')
      .select('owner_id')
      .eq('building_id', buildingId)
      .eq('owner_id', ownerId)
      .maybeSingle();
    return !error && !!data;
  } catch {
    return false;
  }
}

/** Every owner uid on a building's roster (active only unless told otherwise). */
export async function buildingOwnerIds(buildingId: string, activeOnly = true): Promise<string[]> {
  try {
    let q = supabaseAdminEngine.from('building_owners').select('owner_id').eq('building_id', buildingId);
    if (activeOnly) q = q.eq('is_active', true);
    const { data, error } = await q;
    if (error) return [];
    return (data || []).map((r: { owner_id: string }) => String(r.owner_id));
  } catch {
    return [];
  }
}

/** How many owners are still on a building's roster. Used by the super-admin delete guard. */
export async function countActiveBuildingOwners(buildingId: string): Promise<number> {
  try {
    const { count, error } = await supabaseAdminEngine
      .from('building_owners')
      .select('owner_id', { count: 'exact', head: true })
      .eq('building_id', buildingId)
      .eq('is_active', true);
    if (error) return 0;
    return count || 0;
  } catch {
    return 0;
  }
}

export class BuildingFieldError extends Error {}

/**
 * Field normaliser for the building PATCH — returns only the keys actually present, so a
 * partial edit stays partial. Same shape as staffFieldsFrom / accountFieldsFrom.
 */
export function buildingFieldsFrom(body: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};

  const text = (key: string, column: string, max: number) => {
    if (body[key] === undefined) return;
    const v = body[key] === null ? null : String(body[key]).trim().slice(0, max);
    out[column] = v || null;
  };

  if (body.name !== undefined) {
    const name = String(body.name || '').trim();
    if (!name) throw new BuildingFieldError('The building needs a name.');
    out.name = name.slice(0, 200);
  }
  text('houseNo', 'house_no', 40);
  text('address', 'address', 500);
  text('city', 'city', 120);
  text('letterheadUrl', 'letterhead_url', 1000);
  text('signatoryName', 'signatory_name', 200);
  text('signatoryTitle', 'signatory_title', 200);
  text('notes', 'notes', 2000);

  if (Object.keys(out).length) out.updated_at = new Date().toISOString();
  return out;
}

// =====================================================================================
// SYSTEM LOGIN IDENTIFIERS
// =====================================================================================
// Building-tier accounts get a generated login instead of an email address — see
// SYSTEM_LOGIN_DOMAIN in lib/validate.ts for what one looks like and why.
//
// Two owners can legitimately arrive at the same identifier: co-owners of one flat sharing a
// phone, or a flat whose previous owner was detached (the roster row goes, the auth user stays,
// and the address is theirs forever). So a taken identifier is resolved by appending -2, -3 …
// rather than refused, and the caller shows the admin whichever one was actually issued.

/** How far the suffix walks before giving up. Ten owners on one flat is a data-entry problem. */
export const LOGIN_ID_MAX_SUFFIX = 9;

/**
 * Whether a createUser() failure means "that address is taken".
 *
 * GoTrue reports this as a plain 422 with a prose message and no stable code, so matching the
 * message is the only option available. Deliberately NOT a pre-check with listUsers(): that
 * pages at 1000, and between the check and the insert someone else can take the address anyway.
 * Letting the unique constraint answer is race-free.
 */
export function isDuplicateEmailError(err: { message?: string } | null | undefined): boolean {
  return /already|exists|registered/i.test(err?.message || '');
}
