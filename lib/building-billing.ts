import { supabaseAdminEngine } from './supabase-server';

// =====================================================================================
// 🧾 BUILDING SERVICE CHARGE — shared helpers for /api/admin/building/invoices/*.
//
// Lives here rather than in a route.ts because Next.js only allows HTTP handlers to be exported
// from a route file.
//
// The model is lib/billing.ts', one level up and deliberately identical in shape:
// building_service_payments rows are the truth, and an invoice's amount_paid / payment_status /
// paid_at are DERIVED by recalcBuildingInvoice() and written by nothing else.
// =====================================================================================

export const INVOICE_SELECT = '*';

export const BUILDING_PAYMENT_METHODS = ['cash', 'bkash', 'nagad', 'bank', 'other'] as const;
export type BuildingPaymentMethod = (typeof BUILDING_PAYMENT_METHODS)[number];

/**
 * A settled invoice is frozen: once the money is confirmed, the figures may not move and no
 * payment may be added or removed (removing one would walk the status back down through the
 * recalc). Every route that could unsettle an invoice returns this with a 409 — the UI disabling
 * the controls is a courtesy, this is the rule.
 */
export const SETTLED_BUILDING_INVOICE_ERROR =
  'This service charge invoice is settled and can no longer be changed.';

/** Money still owed, never negative — an overpayment reads as zero owed. */
export function balanceOf(invoice: { total_payable?: any; amount_paid?: any } | null): number {
  if (!invoice) return 0;
  return Math.max(0, Number(invoice.total_payable || 0) - Number(invoice.amount_paid || 0));
}

/** "YYYY-MM", or null when the input is not one. */
export function normalizeBillingMonth(value: unknown): string | null {
  const s = String(value ?? '').trim();
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(s) ? s : null;
}

/** The charge lines an invoice is built from. Shared by create and edit so both compute the
 *  total the same way — a total that arrives in the request body is never trusted. */
export function invoiceAmountsFrom(body: Record<string, any>, fallbackServiceCharge = 0) {
  const num = (v: any, dflt = 0) => {
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? n : dflt;
  };
  const serviceCharge = body.serviceCharge === undefined
    ? num(fallbackServiceCharge)
    : num(body.serviceCharge);
  const extraCharge = num(body.extraCharge);
  const discount = num(body.discount);

  return {
    service_charge: serviceCharge,
    extra_charge: extraCharge,
    extra_charge_remarks: body.extraChargeRemarks
      ? String(body.extraChargeRemarks).trim().slice(0, 500)
      : null,
    discount,
    // Computed here, never taken from the client. Clamped at zero: a discount larger than the
    // charge is a data-entry slip, and a negative payable would make the status ladder nonsense.
    total_payable: Math.max(0, serviceCharge + extraCharge - discount),
  };
}

/** Confirm an invoice exists AND belongs to this building. Returns the row, or null — so a
 *  foreign invoice id reads as "not found" rather than being touchable by whoever guessed it. */
export async function ownedBuildingInvoice(invoiceId: string, buildingId: string) {
  const { data } = await supabaseAdminEngine
    .from('building_service_invoices')
    .select(INVOICE_SELECT)
    .eq('id', invoiceId)
    .eq('building_id', buildingId)
    .maybeSingle();
  return data;
}

/**
 * Re-derives an invoice from its payments. The ONLY writer of amount_paid / payment_status /
 * paid_at — every caller that touches building_service_payments must finish by calling this.
 *
 * Ladder: nothing paid -> 'unpaid'; something short of the total -> 'partial'; total reached or
 * exceeded -> 'paid'. Overpayment settles rather than erroring, because people round up.
 */
export async function recalcBuildingInvoice(invoiceId: string) {
  const { data: invoice } = await supabaseAdminEngine
    .from('building_service_invoices')
    .select('id, total_payable')
    .eq('id', invoiceId)
    .maybeSingle();
  if (!invoice) return null;

  const { data: payments } = await supabaseAdminEngine
    .from('building_service_payments')
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

  // The headline date is the LAST payment, stored at 12:00 UTC like every other payment date in
  // this codebase so the calendar day cannot slip when it is read in Bangladesh (UTC+6).
  const latest = rows.length ? rows[rows.length - 1].paid_on : null;
  const paidAt = latest
    ? new Date(`${String(latest).slice(0, 10)}T12:00:00.000Z`).toISOString()
    : null;

  const { data: updated, error } = await supabaseAdminEngine
    .from('building_service_invoices')
    .update({
      amount_paid: amountPaid,
      payment_status: status,
      paid_at: paidAt,
      updated_at: new Date().toISOString(),
    })
    .eq('id', invoiceId)
    .select(INVOICE_SELECT)
    .single();

  if (error) {
    console.error('[building-billing] recalcBuildingInvoice failed:', error.message);
    return null;
  }
  return updated;
}
