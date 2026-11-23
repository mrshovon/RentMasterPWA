import crypto from 'crypto';
import { supabaseAdminEngine } from './supabase-server';
import { logEvent, describeError } from './logger';
import { sendPushToUsers } from './push-send';

// =====================================================================================
// PAYMENT CLAIMS — shared vocabulary and non-Money helpers.
//
// A claim says "I paid you this way, please check". It NEVER creates money: no billing_payments,
// no building_service_payments, no account_transactions, no recalc. The payee still records the
// real receipt, which is the only thing that moves a balance. Keeping that distinction in one
// module is what stops a future edit from quietly turning a message into a payment.
 //
 // Rent already has a `sent` status; service charge does not (its CHECK forbids it), so the
 // open claim is what the flat-owner UI renders as "sent — awaiting confirmation".
// =====================================================================================

export const CLAIM_SOURCES = ['rent', 'service_charge'] as const;
export type ClaimSource = typeof CLAIM_SOURCES[number];

export const CLAIM_METHODS = ['cash', 'proxy', 'bank', 'p2p_qr'] as const;
export type ClaimMethod = typeof CLAIM_METHODS[number];

/** Only these two carry an optional transaction id / remarks worth cross-checking. */
export const DETAIL_METHODS = ['bank', 'p2p_qr'] as const;

export interface PaymentClaim {
  id: string;
  source: ClaimSource;
  ref_id: string;
  payer_id: string;
  payee_id: string;
  method: ClaimMethod;
  reference: string | null;
  note: string | null;
  status: 'pending' | 'confirmed' | 'dismissed';
  created_at: string;
  resolved_at: string | null;
  resolved_by: string | null;
  /** Populated by the read routes from the invoice, for display only. */
  refLabel?: string | null;
  amount?: number | null;
}

export interface PayToConfig {
  account: string | null;
  qrUrl: string | null;
  instructions: string | null;
  methods: ClaimMethod[];
  /** Preselected in the payer's method picker — a default, never a lock. */
  defaultMethod: ClaimMethod;
}

export const EMPTY_PAY_TO: PayToConfig = {
  account: null,
  qrUrl: null,
  instructions: null,
  methods: [...CLAIM_METHODS],
  defaultMethod: 'p2p_qr',
};

const MAX_REFERENCE = 120;
const MAX_NOTE = 500;
const MAX_ACCOUNT = 300;
const MAX_INSTRUCTIONS = 1000;

export function isClaimMethod(v: unknown): v is ClaimMethod {
  return typeof v === 'string' && (CLAIM_METHODS as readonly string[]).includes(v);
}

export function normalizePayTo(raw: any): PayToConfig {
  const rawMethods = Array.isArray(raw?.methods) ? raw.methods : [];
  const methods = (rawMethods.length ? rawMethods : CLAIM_METHODS).filter(isClaimMethod);
  const unique = Array.from(new Set(methods)) as ClaimMethod[];
  const chosen = isClaimMethod(raw?.defaultMethod) ? raw.defaultMethod : EMPTY_PAY_TO.defaultMethod;
  return {
    account: raw?.account ? String(raw.account).trim().slice(0, MAX_ACCOUNT) || null : null,
    qrUrl: raw?.qrUrl ? String(raw.qrUrl).trim().slice(0, 1000) || null : null,
    instructions: raw?.instructions ? String(raw.instructions).trim().slice(0, MAX_INSTRUCTIONS) || null : null,
    methods: unique.length ? unique : [...CLAIM_METHODS],
    defaultMethod: unique.includes(chosen) ? chosen : (unique[0] || EMPTY_PAY_TO.defaultMethod),
  };
}

// Explicit optional fields rather than a discriminated union: this repo compiles with
// strict: false, where boolean literal properties don't narrow reliably at the call site.
export interface ClaimInputResult {
  ok: boolean;
  error?: string;
  method?: ClaimMethod;
  reference?: string | null;
  note?: string | null;
}

export function normalizeClaimInput(body: any): ClaimInputResult {
  const method = body?.method;
  if (!isClaimMethod(method)) {
    return { ok: false, error: 'Choose one of: cash, proxy, bank, or p2p_qr.' };
  }
  const detailsAllowed = (DETAIL_METHODS as readonly string[]).includes(method);
  return {
    ok: true,
    method,
    reference: detailsAllowed && body?.reference
      ? String(body.reference).trim().slice(0, MAX_REFERENCE) || null
      : null,
    note: detailsAllowed && body?.note
      ? String(body.note).trim().slice(0, MAX_NOTE) || null
      : null,
  };
}

export async function pendingClaimFor(source: ClaimSource, refId: string): Promise<PaymentClaim | null> {
  const { data } = await supabaseAdminEngine
    .from('payment_claims')
    .select('*')
    .eq('source', source)
    .eq('ref_id', refId)
    .eq('status', 'pending')
    .maybeSingle();
  return (data as PaymentClaim) || null;
}

/** Claims for a payer (tenant id or owner uid) or a payee (owner/admin uid). Paged by recency. */
export async function listClaims(opts: {
  payerId?: string | null;
  payeeId?: string | null;
  source?: ClaimSource;
}): Promise<PaymentClaim[]> {
  let q = supabaseAdminEngine.from('payment_claims').select('*');
  if (opts.payerId) q = q.eq('payer_id', opts.payerId);
  if (opts.payeeId) q = q.eq('payee_id', opts.payeeId);
  if (opts.source) q = q.eq('source', opts.source);
  const { data, error } = await q.order('created_at', { ascending: false }).limit(200);
  if (error) throw error;
  return (data || []) as PaymentClaim[];
}

export async function resolveClaim(
  claimId: string,
  payeeId: string,
  action: 'confirm' | 'dismiss',
): Promise<PaymentClaim> {
  const { data, error } = await supabaseAdminEngine
    .from('payment_claims')
    .update({
      status: action === 'confirm' ? 'confirmed' : 'dismissed',
      resolved_at: new Date().toISOString(),
      resolved_by: payeeId,
    })
    .eq('id', claimId)
    .eq('payee_id', payeeId)
    .eq('status', 'pending')
    .select('*')
    .single();
  if (error) throw error;
  return data as PaymentClaim;
}

/**
 * Tell the payee a claim arrived. Both halves are non-fatal and independent — a failed push must
 * not lose the inbox row, and a failed insert must not stop the push.
 *
 * The rent title/body are kept CHARACTER-IDENTICAL to the old billing PATCH notice so the
 * existing notice-i18n.ts template still translates them after this route takes over.
 */
export async function notifyClaim(args: {
  source: ClaimSource;
  payeeId: string;
  payerName: string;
  refLabel: string;
  amount: number;
}): Promise<void> {
  const isRent = args.source === 'rent';
  const title = isRent ? 'Rent payment marked as sent' : 'Service charge marked as sent';
  const content = isRent
    ? `${args.payerName} marked the rent for ${args.refLabel} (৳${args.amount}) as sent. Please verify the payment and confirm receipt.`
    : `${args.payerName} says they have paid the service charge for ${args.refLabel} (৳${args.amount}). Please verify the payment and confirm receipt.`;
  try {
    const { error } = await supabaseAdminEngine.from('notices').insert([{
      id: crypto.randomUUID(),
      sender_type: isRent ? 'tenant' : 'owner',
      sender_id: args.payeeId,
      target_scope: 'individual_owner',
      target_owner_id: args.payeeId,
      target_tenant_id: null,
      title,
      content,
      is_clickable: true,
      action_url: isRent ? '/owner#billing' : '/building#invoices',
    }]);
    if (error) throw error;
  } catch (err) {
    await logEvent({
      level: 'warn', source: 'api',
      message: `Payment-claim notice insert failed for ${args.payeeId}`,
      detail: describeError(err).detail,
    });
  }

  try {
    await sendPushToUsers([args.payeeId], {
      title: isRent ? 'Rent marked as sent' : 'Service charge marked as sent',
      body: `${args.payerName} says they've paid ৳${args.amount} for ${args.refLabel}. Please confirm receipt.`,
      url: isRent ? '/owner#billing' : '/building#invoices',
      tag: `claim-${args.source}-${args.refLabel}`,
    });
  } catch (err) {
    await logEvent({
      level: 'warn', source: 'push',
      message: `Payment-claim push failed for ${args.payeeId}`,
      detail: describeError(err).detail,
    });
  }
}
