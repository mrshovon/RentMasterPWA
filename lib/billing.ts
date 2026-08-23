import type { NextRequest } from 'next/server';
import { supabaseAdminEngine } from './supabase-server';

// =====================================================================================
// 🧾 BILLING — shared helpers for the /api/admin/billing routes.
//
// These live here rather than in route.ts because Next.js only allows HTTP handlers (and a
// few config consts) to be exported from a route file — anything else fails the build.
//
// The model: billing_payments rows are the truth. An invoice's amount_paid, payment_status and
// paid_at are DERIVED from them by recalcLedger() and written by nothing else. Every dashboard
// figure reads those derived columns, so they must never be set by hand.
// =====================================================================================

/** The owner id the middleware injected, or null when the request has no usable identity. */
export function ownerId(request: NextRequest): string | null {
  const id = request.headers.get('x-rentmaster-uid');
  if (!id || id === 'YOUR_ACTUAL_USER_UUID_FROM_DATABASE') return null;
  return id;
}

/** Shared by the list and single-payment routes so both return the same shape. */
export const BILLING_PAYMENT_SELECT = '*';

export const PAYMENT_METHODS = ['cash', 'bkash', 'nagad', 'bank', 'other'] as const;
export type BillingPaymentMethod = (typeof PAYMENT_METHODS)[number];

/** Confirm an invoice exists AND belongs to this owner. Returns the row, or null. */
export async function ownedLedger(ledgerId: string, uid: string) {
  const { data } = await supabaseAdminEngine
    .from('billing_ledgers')
    .select('id, tenant_id, property_id, total_payable, amount_paid, payment_status')
    .eq('id', ledgerId)
    .eq('created_by_owner', uid)
    .maybeSingle();
  return data;
}

/**
 * Re-derives an invoice from its payments. The ONLY writer of amount_paid / payment_status /
 * paid_at — every caller that touches billing_payments must finish by calling this.
 *
 * Status ladder: nothing paid -> 'unpaid' (or 'sent', preserved: a tenant who flagged "I've sent
 * it" should not be silently reset just because the owner hasn't recorded the money yet);
 * something paid but short of the total -> 'partial'; total reached or exceeded -> 'paid'.
 * Overpayment is deliberately allowed to settle rather than error — owners round up.
 *
 * Returns the updated ledger so routes can hand the client a correct row without a refetch.
 */
export async function recalcLedger(ledgerId: string) {
  const { data: ledger } = await supabaseAdminEngine
    .from('billing_ledgers')
    .select('id, total_payable, payment_status')
    .eq('id', ledgerId)
    .maybeSingle();
  if (!ledger) return null;

  const { data: payments } = await supabaseAdminEngine
    .from('billing_payments')
    .select('amount, paid_on')
    .eq('ledger_id', ledgerId)
    .order('paid_on', { ascending: true });

  const rows = payments || [];
  const amountPaid = rows.reduce((sum, p) => sum + Number(p.amount || 0), 0);
  const total = Number(ledger.total_payable || 0);

  let status: string;
  if (amountPaid <= 0) status = ledger.payment_status === 'sent' ? 'sent' : 'unpaid';
  else if (amountPaid >= total) status = 'paid';
  else status = 'partial';

  // The receipt's headline date is the LAST payment. Stored at 12:00 UTC, like every other
  // payment date here, so the calendar day cannot slip when it is read in Bangladesh (UTC+6).
  const latest = rows.length ? rows[rows.length - 1].paid_on : null;
  const paidAt = latest ? new Date(`${String(latest).slice(0, 10)}T12:00:00.000Z`).toISOString() : null;

  const { data: updated, error } = await supabaseAdminEngine
    .from('billing_ledgers')
    .update({ amount_paid: amountPaid, payment_status: status, paid_at: paidAt })
    .eq('id', ledgerId)
    .select('*, tenants:tenant_id (name, phone)')
    .single();

  if (error) {
    console.error('[billing] recalcLedger failed:', error.message);
    return null;
  }
  return updated;
}

/**
 * A settled invoice is frozen: once the owner has confirmed the money, neither side may move the
 * status again, and no installment may be added or deleted (deleting one would walk the status
 * back down through recalcLedger). Every billing route that could unsettle a ledger returns this
 * with a 409 — the UI disables the controls, this is what makes the rule real.
 */
export const SETTLED_INVOICE_ERROR = 'This invoice is settled and can no longer be changed.';

/** Money still owed on an invoice, never negative (an overpayment reads as zero owed). */
export function balanceOf(ledger: { total_payable?: any; amount_paid?: any } | null): number {
  if (!ledger) return 0;
  return Math.max(0, Number(ledger.total_payable || 0) - Number(ledger.amount_paid || 0));
}
