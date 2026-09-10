import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import crypto from 'crypto';
import { logEvent } from '@/lib/logger';
import { currentCredentials } from '@/lib/payments/uddoktapay';
import { fulfilUddoktaPayment } from '@/lib/payments/uddoktapay-fulfil';

// =====================================================================================
// UDDOKTAPAY WEBHOOK (IPN)
//
// PUBLIC PATH. middleware.ts gates /api/admin, /api/super-admin and /api/notifications only, so
// /api/payments/* is deliberately outside the auth gate — an external payment processor has no
// Supabase session and never will. Like the cron routes, this endpoint therefore protects
// ITSELF, and like them it FAILS CLOSED: with no key configured there is nothing to compare
// against, so every request is refused rather than waved through.
//
// ⭐ THE BODY IS DISCARDED EXCEPT FOR invoice_id.
// UddoktaPay posts the full payment payload here, and the documented integration is to read it
// and act on `status`. We do not. We take the invoice id, call verify-payment, and act on THAT.
// The reason is worth keeping: this endpoint is on the public internet with a static shared
// secret, so treating its body as authoritative would mean anyone who ever saw that header could
// mint plan activations. Re-verifying makes a forged request achieve nothing — the attacker
// controls only which invoice we ask about, and someone else's real invoice still fails the
// ownership and amount checks in lib/payments/uddoktapay-fulfil.ts.
//
// Always answers 200 on anything it successfully handled, including a duplicate or a payment
// that has not completed. A non-2xx makes the gateway retry, and there is nothing to retry: the
// answer will be identical next time.
// =====================================================================================

export const dynamic = 'force-dynamic';

/** Constant-time compare, so a wrong key cannot be found a byte at a time by timing the reply. */
function keyMatches(provided: string | null, expected: string): boolean {
  if (!provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  // timingSafeEqual throws on a length mismatch, which would itself leak the length.
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export async function POST(request: NextRequest) {
  try {
    const credentials = await currentCredentials();
    if (!credentials) {
      await logEvent({
        level: 'warn',
        source: 'api',
        message: 'UddoktaPay webhook received while the gateway is not configured.',
        code: 'UDDOKTAPAY_WEBHOOK_UNCONFIGURED',
        route: '/api/payments/uddoktapay/webhook',
        method: 'POST',
        status: 401,
      });
      return NextResponse.json({ success: false, error: 'Unauthorized.' }, { status: 401 });
    }

    if (!keyMatches(request.headers.get('RT-UDDOKTAPAY-API-KEY'), credentials.apiKey)) {
      await logEvent({
        level: 'warn',
        source: 'api',
        message: 'UddoktaPay webhook rejected: bad or missing API key header.',
        code: 'UDDOKTAPAY_WEBHOOK_FORBIDDEN',
        route: '/api/payments/uddoktapay/webhook',
        method: 'POST',
        status: 401,
        ip: request.headers.get('x-real-ip') || request.headers.get('x-forwarded-for'),
      });
      return NextResponse.json({ success: false, error: 'Unauthorized.' }, { status: 401 });
    }

    // Read the raw body first so a malformed payload is logged as what actually arrived rather
    // than as an opaque parse error.
    const raw = await request.text();
    let payload: any = null;
    try {
      payload = raw ? JSON.parse(raw) : null;
    } catch { /* handled below */ }

    const invoiceId = String(payload?.invoice_id || '').trim();
    if (!invoiceId) {
      await logEvent({
        level: 'error',
        source: 'api',
        message: 'UddoktaPay webhook payload had no invoice_id.',
        detail: raw.slice(0, 2000),
        code: 'UDDOKTAPAY_WEBHOOK_BAD_PAYLOAD',
        route: '/api/payments/uddoktapay/webhook',
        method: 'POST',
      });
      return NextResponse.json({ success: false, error: 'invoice_id is required.' }, { status: 400 });
    }

    const result = await fulfilUddoktaPayment(invoiceId);

    return NextResponse.json({ success: true, outcome: result.outcome }, { status: 200 });
  } catch (err: any) {
    // Deliberately NOT apiError(): this response is read by a machine, and a 5xx would put the
    // gateway into a retry loop. Log it loudly and answer 200 — the redirect path will fulfil the
    // payment when the owner lands, and an admin has the log line either way.
    await logEvent({
      level: 'error',
      source: 'api',
      message: `UddoktaPay webhook failed: ${err?.message || 'unknown error'}`,
      detail: err?.stack ? String(err.stack).slice(0, 8000) : null,
      code: 'UDDOKTAPAY_WEBHOOK_ERROR',
      route: '/api/payments/uddoktapay/webhook',
      method: 'POST',
    });
    return NextResponse.json({ success: false }, { status: 200 });
  }
}
