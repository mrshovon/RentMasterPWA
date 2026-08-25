import { supabaseAdminEngine } from './supabase-server';

// =====================================================================================
// 🏢💳 WHOLE BUILDING — the commercial lifecycle of a building's contract.
//
// See ADD_BUILDING_PLANS.sql for the schema and the reasoning. In short: a building is created
// UNPAID with a window to pay, paying starts a term, the term warns then graces then LOCKS, and
// renewing extends it. lib/subscription.ts overlays the state this file computes onto the
// building admin's resolved subscription, which is what makes the existing assertOwnerCanWrite()
// gate — and the flat-owner substitution — do all the enforcement work.
//
// ⚠️ THIS MODULE MUST NOT IMPORT ./subscription OR ./building.
// subscription.ts imports THIS file, and building.ts is imported by subscription.ts. A cycle
// would leave one of them half-initialised at module load. Same rule, and the same reason, as
// the warning at the top of lib/building.ts.
//
// ⚠️ EVERYTHING HERE FAILS OPEN. A missing table (before the SQL is run), a PostgREST error, a
// network blip — all read as "this account has no building contract", which leaves every plan
// resolution in the system byte-identical to before this feature existed. A bug that failed
// CLOSED would lock paying customers out of their own data, so the direction is not negotiable.
// =====================================================================================

/** Days a newly created building has to pay before it locks. Used when seeding a subscription. */
export const BUILDING_PAY_WINDOW_DAYS = 15;
/** Fallback buffer after expiry before writes lock. The per-building grace_days column wins. */
export const BUILDING_GRACE_DAYS = 15;
/** Fallback warning runway before expiry. The per-building warn_days column wins. */
export const BUILDING_WARN_DAYS = 30;

const DAY_MS = 24 * 60 * 60 * 1000;

export const BUILDING_PLAN_METHODS = ['cash', 'bkash', 'nagad', 'bank', 'card', 'other'] as const;
export type BuildingPlanMethod = (typeof BUILDING_PLAN_METHODS)[number];

export const PLAN_INVOICE_SELECT = '*';

/** A settled plan invoice is frozen — the figures may not move once the money is confirmed. */
export const SETTLED_PLAN_INVOICE_ERROR =
  'This invoice is settled and can no longer be changed.';

export interface BuildingSubscriptionRow {
  building_id: string;
  admin_id: string;
  term_months: number;
  term_starts_on: string | null;
  expiry_date: string | null;
  pay_by: string;
  first_paid_at: string | null;
  grace_days: number;
  warn_days: number;
  canceled_at: string | null;
  notes: string | null;
  created_at?: string;
  updated_at?: string;
}

/**
 * The lifecycle fields lib/subscription.ts overlays onto a resolved subscription. Deliberately a
 * SUBSET of OwnerSubscription — tierId, tierName and limits are never touched, so the building
 * keeps the whole_building tier's bundled modules and unlimited limits whatever its billing
 * state. Only whether it may WRITE changes.
 */
export interface BuildingPlanState {
  status: 'active' | 'grace' | 'locked';
  lockReason: 'expired' | 'revoked' | null;
  expiryDate: string | null;
  daysUntilExpiry: number | null;
  graceEndsAt: string | null;
  daysLeftInGrace: number | null;
  warnExpiringSoon: boolean;
  /** True while the building has never paid and is still inside its pay-by window. */
  unpaidWindow: boolean;
  /** Days left to pay before the initial lock. Null once the first payment has landed. */
  daysToPay: number | null;
  /** The pay-by deadline, echoed so the UI can name the date rather than only a countdown. */
  payBy: string | null;
}

// -------------------------------------------------------------------------------------
// Date helpers.
//
// Every date column here is a DATE, not a timestamp, and is compared at NOON UTC. Bangladesh is
// UTC+6, so parsing a bare "2026-08-25" as midnight UTC and comparing it against local now()
// makes the calendar day flip six hours early — which on a lock boundary means an admin loses
// access on the evening of the day they were told they had. The same 12:00 convention is already
// used by recalcBuildingInvoice() when it stamps paid_at.
// -------------------------------------------------------------------------------------
function dayMs(date: string | null | undefined): number | null {
  const s = String(date || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const t = new Date(`${s}T12:00:00.000Z`).getTime();
  return Number.isFinite(t) ? t : null;
}

/** Whole days from now until `ms`, rounded up. Negative once the moment has passed. */
function daysFromNow(ms: number): number {
  return Math.ceil((ms - Date.now()) / DAY_MS);
}

/** "YYYY-MM-DD" for a timestamp. */
export function isoDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** `date` + n calendar months, as "YYYY-MM-DD". Calendar arithmetic, not 30-day blocks — a term
 *  bought on the 15th should end on the 15th. Mirrors computeExpiry() in lib/payments/activate.ts. */
export function addMonths(date: string, months: number): string {
  const d = new Date(`${String(date).slice(0, 10)}T12:00:00.000Z`);
  d.setUTCMonth(d.getUTCMonth() + months);
  return d.toISOString().slice(0, 10);
}

/** Today as "YYYY-MM-DD". */
export function today(): string {
  return new Date().toISOString().slice(0, 10);
}

// -------------------------------------------------------------------------------------
// The state machine.
// -------------------------------------------------------------------------------------

/**
 * Derive a building's billing state from the stored facts. Pure — no I/O, no clock beyond
 * Date.now() — so it is the same answer wherever it is called from: the plan overlay, the
 * admin console listing, and the notification cron all classify identically.
 *
 * Order matters:
 *   1. canceled  -> locked / 'revoked'. A deliberate administrative act, not a billing event,
 *      so it must not be softened into "your plan lapsed". Same precedence permissions_revoked
 *      has in lib/subscription.ts.
 *   2. never paid -> inside the pay-by window: ACTIVE with a countdown. Past it: LOCKED.
 *      Full access during the window is the point — a building that has just been set up must be
 *      able to load its owners in before the invoice clears.
 *   3. paid -> active / grace / locked off expiry_date.
 *
 * ⚠️ The terminal state is LOCKED, never a drop to Free. This is the one deliberate divergence
 * from the owner lifecycle, which downgrades to the 2/2 free baseline at the end of grace. A
 * whole building cannot operate on two properties, and the fallback would silently strip the
 * bundled modules from every flat owner underneath it.
 */
export function buildingPlanState(row: BuildingSubscriptionRow): BuildingPlanState {
  const base: BuildingPlanState = {
    status: 'active',
    lockReason: null,
    expiryDate: row.expiry_date || null,
    daysUntilExpiry: null,
    graceEndsAt: null,
    daysLeftInGrace: null,
    warnExpiringSoon: false,
    unpaidWindow: false,
    daysToPay: null,
    payBy: row.pay_by || null,
  };

  if (row.canceled_at) {
    return { ...base, status: 'locked', lockReason: 'revoked' };
  }

  // --- Never paid: the initial window.
  if (!row.first_paid_at) {
    const payBy = dayMs(row.pay_by);
    // A subscription row with no usable pay-by date must not lock anyone out on a parse failure.
    if (payBy === null) return base;
    const daysToPay = daysFromNow(payBy);
    // warnExpiringSoon stays FALSE here even though this building plainly needs attention:
    // there is no expiry to be near. `unpaidWindow` is the signal for this state, and every
    // consumer branches on it first. Setting both would make "expiring soon" mean two things.
    if (daysToPay >= 0) {
      return { ...base, unpaidWindow: true, daysToPay };
    }
    return { ...base, status: 'locked', lockReason: 'expired', unpaidWindow: true, daysToPay };
  }

  // --- Paid: the ordinary term.
  const end = dayMs(row.expiry_date);
  // Paid but with no expiry recorded reads as an open-ended contract rather than an expired one.
  // The opposite reading would lock a building because of a data-entry gap.
  if (end === null) return base;

  const graceDays = Number.isFinite(Number(row.grace_days)) ? Number(row.grace_days) : BUILDING_GRACE_DAYS;
  const warnDays = Number.isFinite(Number(row.warn_days)) ? Number(row.warn_days) : BUILDING_WARN_DAYS;
  const graceEnd = end + graceDays * DAY_MS;
  const daysUntilExpiry = daysFromNow(end);
  const now = Date.now();

  const withDates = {
    ...base,
    daysUntilExpiry,
    graceEndsAt: new Date(graceEnd).toISOString(),
  };

  if (now < end) {
    return {
      ...withDates,
      status: 'active',
      warnExpiringSoon: daysUntilExpiry > 0 && daysUntilExpiry <= warnDays,
    };
  }
  if (now < graceEnd) {
    return {
      ...withDates,
      status: 'grace',
      daysLeftInGrace: Math.max(0, daysFromNow(graceEnd)),
    };
  }
  return { ...withDates, status: 'locked', lockReason: 'expired' };
}

// -------------------------------------------------------------------------------------
// The hot-path lookup.
//
// resolveOwnSubscription() calls this for EVERY account it resolves, building or not, and that
// runs 2-3 times in a single write. The answer changes only when an admin records a payment or
// edits a term, so a short TTL cache is safe: the worst case is a minute of stale billing state.
// The map is per serverless instance, which is short-lived anyway. Same shape and the same
// reasoning as buildingMembershipOf() in lib/building.ts.
// -------------------------------------------------------------------------------------
const PLAN_TTL_MS = 60_000;
const planCache = new Map<string, { value: BuildingSubscriptionRow | null; at: number }>();

/**
 * This account's building contract, or null. Null means BOTH "not a building admin" and "the
 * lookup failed" — they are the same answer on purpose, because both must leave plan resolution
 * exactly as it was before this feature.
 */
export async function buildingPlanOf(adminId: string): Promise<BuildingSubscriptionRow | null> {
  if (!adminId) return null;

  const hit = planCache.get(adminId);
  if (hit && Date.now() - hit.at < PLAN_TTL_MS) return hit.value;

  let value: BuildingSubscriptionRow | null = null;
  try {
    const { data, error } = await supabaseAdminEngine
      .from('building_subscriptions')
      .select('*')
      .eq('admin_id', adminId)
      .maybeSingle();
    if (!error && data) value = data as BuildingSubscriptionRow;
  } catch {
    value = null;
  }

  planCache.set(adminId, { value, at: Date.now() });
  if (planCache.size > 5000) planCache.clear();
  return value;
}

/** Drop a cached contract after a payment or a term edit, so the change shows immediately. */
export function forgetBuildingPlan(adminId: string): void {
  planCache.delete(adminId);
}

/** The building's contract by building id — for the admin console, which works building-first. */
export async function planForBuilding(buildingId: string): Promise<BuildingSubscriptionRow | null> {
  try {
    const { data, error } = await supabaseAdminEngine
      .from('building_subscriptions')
      .select('*')
      .eq('building_id', buildingId)
      .maybeSingle();
    if (error) return null;
    return (data as BuildingSubscriptionRow) || null;
  } catch {
    return null;
  }
}

/**
 * Create the contract row for a building that has none — a newly provisioned building, or one
 * that predates this feature and was somehow missed by the backfill. Best-effort: a building
 * whose contract row fails to insert must still be usable, and the missing row simply reads as
 * "no contract" (perpetual), which is how every building behaved before this shipped.
 */
export async function ensureBuildingSubscription(
  buildingId: string,
  adminId: string,
  opts: { termMonths?: number; payWindowDays?: number } = {}
): Promise<BuildingSubscriptionRow | null> {
  const existing = await planForBuilding(buildingId);
  if (existing) return existing;

  const windowDays = Number(opts.payWindowDays ?? BUILDING_PAY_WINDOW_DAYS);
  const payBy = isoDay(Date.now() + windowDays * DAY_MS);

  try {
    const { data, error } = await supabaseAdminEngine
      .from('building_subscriptions')
      .insert([{
        building_id: buildingId,
        admin_id: adminId,
        term_months: Number(opts.termMonths ?? 12),
        pay_by: payBy,
      }])
      .select('*')
      .single();
    if (error) {
      console.error('[building-plan] ensureBuildingSubscription failed (non-fatal):', error.message);
      return null;
    }
    forgetBuildingPlan(adminId);
    return data as BuildingSubscriptionRow;
  } catch (err) {
    console.error('[building-plan] ensureBuildingSubscription threw (non-fatal):', err);
    return null;
  }
}

// -------------------------------------------------------------------------------------
// Money.
// -------------------------------------------------------------------------------------

/** Money still owed, never negative — an overpayment reads as zero owed. */
export function planBalanceOf(invoice: { total_payable?: any; amount_paid?: any } | null): number {
  if (!invoice) return 0;
  return Math.max(0, Number(invoice.total_payable || 0) - Number(invoice.amount_paid || 0));
}

/** Normalise a submitted line-item list into rows, and total them. The client's total is never
 *  trusted — only its labels and per-line amounts are, and even those are clamped. */
export function itemsFrom(raw: unknown): { label: string; amount: number; sort_order: number }[] {
  if (!Array.isArray(raw)) return [];
  const out: { label: string; amount: number; sort_order: number }[] = [];
  raw.forEach((item: any, i) => {
    const label = String(item?.label ?? '').trim().slice(0, 200);
    if (!label) return;
    const n = Number(item?.amount);
    out.push({ label, amount: Number.isFinite(n) && n >= 0 ? n : 0, sort_order: i });
  });
  return out;
}

/**
 * Re-derives a plan invoice from its payments. The ONLY writer of amount_paid / payment_status /
 * paid_at — every caller that touches building_plan_payments must finish by calling this.
 * A direct port of recalcBuildingInvoice() in lib/building-billing.ts.
 */
export async function recalcPlanInvoice(invoiceId: string) {
  const { data: invoice } = await supabaseAdminEngine
    .from('building_plan_invoices')
    .select('id, total_payable, status')
    .eq('id', invoiceId)
    .maybeSingle();
  if (!invoice) return null;

  const { data: payments } = await supabaseAdminEngine
    .from('building_plan_payments')
    .select('amount, paid_on')
    .eq('invoice_id', invoiceId)
    .order('paid_on', { ascending: true });

  const rows = payments || [];
  const amountPaid = rows.reduce((sum, p) => sum + Number(p.amount || 0), 0);
  const total = Number(invoice.total_payable || 0);

  let status: string;
  if (amountPaid <= 0) status = 'unpaid';
  else if (amountPaid >= total) status = 'paid';
  else status = 'partial';

  const latest = rows.length ? rows[rows.length - 1].paid_on : null;
  const paidAt = latest
    ? new Date(`${String(latest).slice(0, 10)}T12:00:00.000Z`).toISOString()
    : null;

  // A fully paid invoice settles; walking a payment back re-opens it. `void` is an admin decision
  // and is never overwritten by the money.
  const nextStatus =
    invoice.status === 'void'
      ? 'void'
      : status === 'paid'
        ? 'settled'
        : invoice.status === 'settled'
          ? 'sent'
          : invoice.status;

  const { data: updated, error } = await supabaseAdminEngine
    .from('building_plan_invoices')
    .update({
      amount_paid: amountPaid,
      payment_status: status,
      paid_at: paidAt,
      status: nextStatus,
      updated_at: new Date().toISOString(),
    })
    .eq('id', invoiceId)
    .select(PLAN_INVOICE_SELECT)
    .single();

  if (error) {
    console.error('[building-plan] recalcPlanInvoice failed:', error.message);
    return null;
  }
  return updated;
}

/**
 * Move the building's term forward because an invoice has been paid in full.
 *
 * ⚠️ THE START DATE IS max(today, current expiry) — renewing early ADDS to the remaining term
 * instead of forfeiting it. The owner path does not do this: activateSubscription() in
 * lib/payments/activate.ts always computes expiry from new Date(), so an owner who renews a
 * yearly plan twenty days early silently loses those twenty days. On a yearly building contract
 * that is real money, and the renewal conversation happens weeks ahead by design. Do not
 * "simplify" this back to today + months.
 *
 * The first payment also stamps first_paid_at, which is what ends the unpaid window.
 */
export async function activateBuildingTerm(
  buildingId: string,
  opts: { months?: number; startOn?: string | null } = {}
): Promise<BuildingSubscriptionRow | null> {
  const sub = await planForBuilding(buildingId);
  if (!sub) return null;

  const months = Number(opts.months ?? sub.term_months ?? 12) || 12;
  const now = today();

  let start: string;
  if (opts.startOn && /^\d{4}-\d{2}-\d{2}$/.test(String(opts.startOn).slice(0, 10))) {
    start = String(opts.startOn).slice(0, 10);
  } else {
    const currentEnd = sub.expiry_date ? String(sub.expiry_date).slice(0, 10) : null;
    start = currentEnd && currentEnd > now ? currentEnd : now;
  }

  const patch: Record<string, any> = {
    term_starts_on: sub.term_starts_on || start,
    expiry_date: addMonths(start, months),
    term_months: months,
    updated_at: new Date().toISOString(),
  };
  if (!sub.first_paid_at) patch.first_paid_at = new Date().toISOString();

  const { data, error } = await supabaseAdminEngine
    .from('building_subscriptions')
    .update(patch)
    .eq('building_id', buildingId)
    .select('*')
    .single();

  if (error) {
    console.error('[building-plan] activateBuildingTerm failed:', error.message);
    return null;
  }
  forgetBuildingPlan(sub.admin_id);
  return data as BuildingSubscriptionRow;
}

/** Confirm an invoice exists AND belongs to this building, so a guessed id reads as not-found. */
export async function ownedPlanInvoice(invoiceId: string, buildingId: string) {
  const { data } = await supabaseAdminEngine
    .from('building_plan_invoices')
    .select(PLAN_INVOICE_SELECT)
    .eq('id', invoiceId)
    .eq('building_id', buildingId)
    .maybeSingle();
  return data;
}
