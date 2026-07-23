import type { NextRequest } from 'next/server';
import { supabaseAdminEngine } from './supabase-server';
import { resolveFeature } from './features';
import crypto from 'crypto';

// =====================================================================================
// 💰 ACCOUNTS — shared helpers for the /api/admin/accounts routes.
//
// These live here rather than in route.ts because Next.js only allows HTTP handlers (and a
// few config consts) to be exported from a route file — anything else fails the build.
//
// Two automations also live here (bookAutoTransaction / reverseAutoTransaction): marking an
// invoice Paid books an income, and logging a staff salary books an expense. Both post to the
// owner's DEFAULT account and are deliberately best-effort — a caller must never fail its own
// request because the bookkeeping side-effect broke, and nothing is booked when the owner has
// no default account or hasn't got the Accounts feature enabled.
// =====================================================================================

/** The owner id the middleware injected, or null when the request has no usable identity. */
export function ownerId(request: NextRequest): string | null {
  const id = request.headers.get('x-rentmaster-uid');
  if (!id || id === 'YOUR_ACTUAL_USER_UUID_FROM_DATABASE') return null;
  return id;
}

export const ACCOUNT_TYPES = ['cash', 'bank', 'mfs', 'other'] as const;
export type AccountType = (typeof ACCOUNT_TYPES)[number];

export const TXN_DIRECTIONS = ['income', 'expense'] as const;
export type TxnDirection = (typeof TXN_DIRECTIONS)[number];

// Selects shared by list and single-record routes so every response has the same shape.
export const ACCOUNT_SELECT = '*';
export const TXN_SELECT =
  '*, properties:property_id ( id, name, flat_no ), accounts:account_id ( id, name, type )';
export const TRANSFER_SELECT =
  '*, from_account:from_account_id ( id, name, type ), to_account:to_account_id ( id, name, type )';

/**
 * Normalise the editable account fields off a request body. Used by POST and PATCH so the two
 * can never drift. Only keys actually present are returned, so PATCH stays a partial update.
 * NOTE: is_default is handled separately (see setDefaultAccount) — it can't be a plain field
 * update because at most one account per owner may be the default.
 */
export function accountFieldsFrom(body: any): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const text = (v: any) => {
    const s = String(v ?? '').trim();
    return s === '' ? null : s;
  };
  if (body.name !== undefined) out.name = text(body.name);
  if (body.type !== undefined) out.type = ACCOUNT_TYPES.includes(body.type) ? body.type : 'cash';
  if (body.openingBalance !== undefined) out.opening_balance = Number(body.openingBalance) || 0;
  if (body.note !== undefined) out.note = text(body.note);
  if (body.isActive !== undefined) out.is_active = !!body.isActive;
  return out;
}

/**
 * Normalise the editable transaction fields off a request body. account_id / property_id are
 * resolved separately (they must be proven to belong to the owner), and source/source_ref are
 * never taken from the body — manual entries are always source = 'manual'.
 */
export function txnFieldsFrom(body: any): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const text = (v: any) => {
    const s = String(v ?? '').trim();
    return s === '' ? null : s;
  };
  if (body.direction !== undefined) {
    out.direction = TXN_DIRECTIONS.includes(body.direction) ? body.direction : 'expense';
  }
  if (body.amount !== undefined) out.amount = Number(body.amount);
  if (body.category !== undefined) out.category = text(body.category);
  if (body.txnDate !== undefined) out.txn_date = String(body.txnDate ?? '').slice(0, 10);
  if (body.note !== undefined) out.note = text(body.note);
  return out;
}

/** Confirm an account row exists AND belongs to this owner. */
export async function ownsAccount(id: string, uid: string): Promise<boolean> {
  const { data } = await supabaseAdminEngine
    .from('accounts')
    .select('id')
    .eq('id', id)
    .eq('owner_id', uid)
    .maybeSingle();
  return !!data;
}

/**
 * Resolve a property the caller is attaching a transaction to, proving it belongs to this owner.
 * Returns `undefined` when the caller didn't touch the field, `null` to leave it unset.
 * Throws when the id isn't one of the owner's properties (never trust an id from the body).
 */
export async function resolveOwnerPropertyId(
  body: any,
  uid: string
): Promise<string | null | undefined> {
  if (body.propertyId === undefined) return undefined;
  const raw = String(body.propertyId ?? '').trim();
  if (!raw) return null;
  const { data: owned } = await supabaseAdminEngine
    .from('properties')
    .select('id')
    .eq('id', raw)
    .eq('owner_id', uid)
    .maybeSingle();
  if (!owned) throw new Error('That property is not yours.');
  return owned.id;
}

/**
 * Set (or move) this owner's default account. The partial unique index accounts_one_default_idx
 * forbids two defaults, so the previous default is cleared first. Idempotent.
 */
export async function setDefaultAccount(id: string, uid: string): Promise<void> {
  await supabaseAdminEngine
    .from('accounts')
    .update({ is_default: false, updated_at: new Date().toISOString() })
    .eq('owner_id', uid)
    .eq('is_default', true)
    .neq('id', id);
  await supabaseAdminEngine
    .from('accounts')
    .update({ is_default: true, updated_at: new Date().toISOString() })
    .eq('id', id)
    .eq('owner_id', uid);
}

// -------------------------------------------------------------------------------------
// Automations — best-effort, feature-gated. Callers wrap these in try/catch and never let
// a failure here break the invoice / salary flow that triggered them.
// -------------------------------------------------------------------------------------

interface AutoTxnInput {
  direction: TxnDirection;
  amount: number;
  propertyId: string | null;
  category: string;
  txnDate: string; // YYYY-MM-DD
  source: 'billing' | 'staff_salary';
  sourceRef: string;
}

/**
 * Book an automatic income/expense into the owner's default account. No-op (and no error) when:
 *   - the owner doesn't have the Accounts feature enabled,
 *   - the amount isn't a positive number,
 *   - the owner has no active default account (they simply haven't set one up yet).
 * Idempotent: upserts on the (source, source_ref) unique index, so re-firing the same event
 * (e.g. re-marking an invoice Paid) updates the single row instead of duplicating it.
 */
export async function bookAutoTransaction(uid: string, input: AutoTxnInput): Promise<void> {
  const amount = Number(input.amount);
  if (!Number.isFinite(amount) || amount <= 0) return;

  const feature = await resolveFeature(uid, 'accounts');
  if (!feature.enabled) return;

  const { data: acct } = await supabaseAdminEngine
    .from('accounts')
    .select('id')
    .eq('owner_id', uid)
    .eq('is_default', true)
    .eq('is_active', true)
    .maybeSingle();
  if (!acct) return; // no default account -> nothing to book against

  const txnDate = /^\d{4}-\d{2}-\d{2}$/.test(input.txnDate)
    ? input.txnDate
    : new Date().toISOString().slice(0, 10);

  // Delete-then-insert rather than upsert: the (source, source_ref) unique index is PARTIAL
  // (where source <> 'manual'), and PostgREST's onConflict can't name a partial index's predicate.
  // Clearing any prior auto-row first keeps this idempotent, and the partial index still guards
  // against a double-fire race (the second insert errors and is swallowed below).
  await reverseAutoTransaction(uid, input.source, input.sourceRef);

  const { error } = await supabaseAdminEngine
    .from('account_transactions')
    .insert([{
      id: crypto.randomUUID(),
      owner_id: uid,
      account_id: acct.id,
      property_id: input.propertyId,
      direction: input.direction,
      amount,
      category: input.category,
      txn_date: txnDate,
      note: null,
      source: input.source,
      source_ref: input.sourceRef,
    }]);
  if (error) console.error('[accounts] bookAutoTransaction failed (non-fatal):', error.message);
}

/** Remove the auto-created row for an event (invoice un-marked paid, staff payment deleted). */
export async function reverseAutoTransaction(
  uid: string,
  source: 'billing' | 'staff_salary',
  sourceRef: string
): Promise<void> {
  const { error } = await supabaseAdminEngine
    .from('account_transactions')
    .delete()
    .eq('owner_id', uid)
    .eq('source', source)
    .eq('source_ref', sourceRef);
  if (error) console.error('[accounts] reverseAutoTransaction failed (non-fatal):', error.message);
}
