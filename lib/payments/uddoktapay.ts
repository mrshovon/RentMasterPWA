import {
  getUddoktaPayConfig,
  getPaymentConfig,
  type UddoktaPayConfig,
  type PaymentMethods,
} from '../app-settings';
import { decryptField } from '../field-crypto';
import { logEvent, describeError } from '../logger';

// =====================================================================================
// UDDOKTAPAY (Paymently) HTTP CLIENT
//
// Three calls — create a charge, verify one, refund one — over one `call()` that owns the
// error handling. Nothing else in the codebase talks to the gateway directly.
//
// ⚠️ THE ONE THING THAT MAKES THIS API DANGEROUS TO WRAP NAIVELY:
// business failures come back as HTTP **200** with `{ status: false, message }`. A `res.ok`
// check — the obvious thing to write — reports a declined or misconfigured charge as a success
// and hands the caller `payment_url: undefined`. `call()` treats `status === false` as a throw,
// so a caller can never mistake one for the other.
//
// Credentials are never imported from the environment here; they come from the admin panel
// (app_settings.uddoktapay_config) and are decrypted per call. See activeCredentials().
// =====================================================================================

/** Requests that hang are worse than requests that fail: an owner is watching a spinner. */
const TIMEOUT_MS = 15_000;

/** Raised for every gateway failure — transport, HTTP status, or `status: false`. */
export class UddoktaPayError extends Error {
  // A plain field rather than a constructor parameter property, so this module can be executed
  // by `node --experimental-strip-types` for a quick contract check against the sandbox.
  // Strip-only mode cannot compile parameter properties.
  readonly detail?: unknown;
  constructor(message: string, detail?: unknown) {
    super(message);
    this.name = 'UddoktaPayError';
    this.detail = detail;
  }
}

export interface UddoktaCredentials {
  baseUrl: string;
  apiKey: string;
  mode: 'sandbox' | 'live';
}

/**
 * The credentials for whichever mode is selected, decrypted. Returns null when the gateway is
 * not usable — no key stored, no base URL, or the stored key will not decrypt (a rotated
 * FIELD_ENCRYPTION_KEY looks exactly like "never configured" otherwise, which is why callers
 * should surface the difference rather than silently offering a broken button).
 *
 * Backend only. This value must never be serialised into a response.
 */
export function activeCredentials(cfg: UddoktaPayConfig): UddoktaCredentials | null {
  const live = cfg.mode === 'live';
  const baseUrl = (live ? cfg.liveBaseUrl : cfg.sandboxBaseUrl || '').trim().replace(/\/+$/, '');
  const apiKey = decryptField(live ? cfg.liveApiKeyEnc : cfg.sandboxApiKeyEnc) || '';
  if (!baseUrl || !apiKey) return null;
  return { baseUrl, apiKey, mode: cfg.mode };
}

/** Convenience: read the config and resolve credentials in one step. */
export async function currentCredentials(): Promise<UddoktaCredentials | null> {
  return activeCredentials(await getUddoktaPayConfig());
}

/**
 * Which payment methods an owner may actually be offered right now.
 *
 * The admin's `methods` choice is an intent; this is the reality. A gateway with no usable key
 * is silently demoted to 'manual' rather than shown as a button that 500s — and if the admin
 * chose 'uddoktapay' only, the fallback is still manual, because leaving an owner with NO way to
 * pay is worse than showing them one the admin meant to hide.
 */
export async function availablePaymentMethods(): Promise<PaymentMethods> {
  const [pay, creds] = await Promise.all([getPaymentConfig(), currentCredentials()]);
  if (pay.methods === 'manual') return 'manual';
  if (!creds) return 'manual';
  return pay.methods;
}

async function call<T>(
  credentials: UddoktaCredentials,
  path: string,
  body: Record<string, unknown>,
): Promise<T> {
  const url = `${credentials.baseUrl}/${path}`;
  let res: Response;
  let raw: string;

  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'RT-UDDOKTAPAY-API-KEY': credentials.apiKey,
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      cache: 'no-store',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    raw = await res.text();
  } catch (err: any) {
    // Timeouts arrive here as an AbortError; name them, because "fetch failed" tells an admin
    // reading the logs nothing about whether to retry.
    const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    const described = describeError(err);
    await logEvent({
      level: 'error',
      source: 'api',
      message: `UddoktaPay ${path}: ${timedOut ? 'timed out' : 'unreachable'}`,
      detail: described.detail,
      code: 'UDDOKTAPAY_TRANSPORT',
      context: { path, mode: credentials.mode, timedOut, error: described.message },
    });
    throw new UddoktaPayError(
      timedOut
        ? 'The payment gateway did not respond in time. Please try again.'
        : 'Could not reach the payment gateway. Please try again.',
    );
  }

  let parsed: any = null;
  try {
    parsed = raw ? JSON.parse(raw) : null;
  } catch {
    /* handled below — an unparseable body is a failure whatever the status was */
  }

  if (!res.ok || parsed === null) {
    await logEvent({
      level: 'error',
      source: 'api',
      message: `UddoktaPay ${path}: unexpected response`,
      // Truncated: a gateway error page can be a whole HTML document.
      detail: raw.slice(0, 2000),
      status: res.status,
      code: 'UDDOKTAPAY_HTTP',
      context: { path, mode: credentials.mode },
    });
    throw new UddoktaPayError(`The payment gateway returned an unexpected response (${res.status}).`);
  }

  // See the header note. This is the branch that matters.
  if (parsed.status === false) {
    await logEvent({
      level: 'warn',
      source: 'api',
      message: `UddoktaPay ${path} rejected: ${parsed.message || 'no reason given'}`,
      code: 'UDDOKTAPAY_REJECTED',
      context: { path, mode: credentials.mode },
    });
    throw new UddoktaPayError(parsed.message || 'The payment gateway rejected the request.', parsed);
  }

  return parsed as T;
}

// -------------------------------------------------------------------------------------
// 1. Create charge
// -------------------------------------------------------------------------------------

export interface CreateChargeArgs {
  fullName: string;
  email: string;
  /** Major units (taka). Serialised as a string — the API takes strings for every field. */
  amount: number;
  /** Our own reconciliation payload. Comes back verbatim on verify and on the webhook. */
  metadata: Record<string, string>;
  redirectUrl: string;
  cancelUrl: string;
  webhookUrl?: string;
}

export interface CreateChargeResult {
  status: true;
  message: string;
  payment_url: string;
}

export async function createCharge(
  args: CreateChargeArgs,
  credentials: UddoktaCredentials,
): Promise<CreateChargeResult> {
  const result = await call<CreateChargeResult>(credentials, 'checkout-v2', {
    full_name: args.fullName,
    email: args.email,
    // Two decimals always: the amount we send here is the amount we later compare the verified
    // amount against, and "1500" vs "1500.00" must not be able to fail that comparison.
    amount: args.amount.toFixed(2),
    metadata: args.metadata,
    redirect_url: args.redirectUrl,
    cancel_url: args.cancelUrl,
    // GET so invoice_id arrives as a query parameter the return page can simply read. With the
    // default POST, the gateway form-posts to our redirect URL — which a static frontend route
    // cannot receive at all.
    return_type: 'GET',
    ...(args.webhookUrl ? { webhook_url: args.webhookUrl } : {}),
  });

  if (!result?.payment_url) {
    throw new UddoktaPayError('The payment gateway did not return a checkout link.');
  }
  return result;
}

// -------------------------------------------------------------------------------------
// 2. Verify payment
// -------------------------------------------------------------------------------------

export type UddoktaPaymentStatus = 'COMPLETED' | 'PENDING' | 'ERROR';

export interface VerifyPaymentResult {
  full_name: string;
  email: string;
  amount: string;
  fee: string;
  charged_amount: string;
  invoice_id: string;
  metadata: Record<string, string> | null;
  payment_method: string;
  sender_number: string;
  transaction_id: string;
  date: string;
  status: UddoktaPaymentStatus;
}

/**
 * Ask the gateway what actually happened. This is the ONLY statement about a payment this app
 * trusts — not the redirect, and not the webhook body either. See uddoktapay-fulfil.ts.
 *
 * ⚠️ THIS ENDPOINT REPORTS ITS OWN FAILURES AS A PAYMENT STATUS, AND THEY LOOK IDENTICAL.
 * Verified against the sandbox on 2026-09-10 — every one of these is HTTP 200:
 *
 *   good key, unknown invoice  ->  { status: "ERROR", message: "No Data Found" }
 *   wrong key                  ->  { status: "ERROR", message: "Api Do Not Match" }
 *   missing key                ->  { status: "ERROR", message: "Api Not Found" }
 *   real payment               ->  { status: "COMPLETED", invoice_id, amount, … }
 *
 * So `status: "ERROR"` does NOT mean "this payment failed". Passing it through as one would tell
 * somebody who has just paid that their payment failed, because our own API key was wrong — the
 * single worst thing this integration could say. A genuine payment record always carries an
 * `invoice_id`; these do not, and that is the tell we use to reject them as API failures instead.
 */
export async function verifyPayment(
  invoiceId: string,
  credentials: UddoktaCredentials,
): Promise<VerifyPaymentResult> {
  const result = await call<VerifyPaymentResult>(credentials, 'verify-payment', {
    invoice_id: invoiceId,
  });

  if (!result?.invoice_id) {
    await logEvent({
      level: 'error',
      source: 'api',
      message: `UddoktaPay verify-payment returned no record: ${(result as any)?.message || 'no message'}`,
      code: 'UDDOKTAPAY_VERIFY_NO_RECORD',
      context: { invoiceId, mode: credentials.mode, status: (result as any)?.status },
    });
    throw new UddoktaPayError(
      // Deliberately not "your payment failed". We do not know that, and must not imply it.
      'We could not confirm this payment with the gateway.',
      result,
    );
  }

  return result;
}

// -------------------------------------------------------------------------------------
// 3. Refund payment
// -------------------------------------------------------------------------------------

export interface RefundArgs {
  transactionId: string;
  paymentMethod: string;
  /** Major units (taka). */
  amount: number;
  productName: string;
  reason: string;
}

/**
 * ⚠️ These five fields are what the endpoint actually wants — `transaction_id`,
 * `payment_method`, `amount`, `product_name`, `reason` — verified against the UddoktaPay Refund
 * API reference on 2026-09-10. It does NOT take `invoice_id`, which is the natural assumption
 * given verify does. That is why fulfilment stores the transaction id and payment method on the
 * submission row: by refund time they cannot be re-derived from anything we kept.
 */
export async function refundPayment(
  args: RefundArgs,
  credentials: UddoktaCredentials,
): Promise<Record<string, unknown>> {
  return call<Record<string, unknown>>(credentials, 'refund-payment', {
    transaction_id: args.transactionId,
    payment_method: args.paymentMethod,
    amount: args.amount.toFixed(2),
    product_name: args.productName,
    reason: args.reason,
  });
}
