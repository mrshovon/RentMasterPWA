import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { apiError } from '@/lib/api-response';
import { fulfilUddoktaPayment } from '@/lib/payments/uddoktapay-fulfil';

// =====================================================================================
// UDDOKTAPAY VERIFY — OWNER SIDE
// POST { invoiceId } -> confirm and fulfil a payment the owner has just come back from.
//
// Called by the return page. This is the path that must work when the webhook does not: a
// webhook can be blocked by a firewall, delayed, or simply never configured, and the owner is
// standing there having paid. It races the webhook by design and fulfilment is idempotent, so
// whichever arrives first wins and the other reports 'already_fulfilled'.
//
// The owner's identity is injected by middleware, but note that fulfilment does NOT trust it to
// decide ownership — it re-verifies with the gateway and matches on the metadata written at
// charge time. Someone who guessed another owner's invoice id would still fail every check in
// lib/payments/uddoktapay-fulfil.ts; passing an id here grants nothing.
// =====================================================================================

export async function POST(request: NextRequest) {
  try {
    const uid = request.headers.get('x-rentmaster-uid');
    if (!uid) {
      return NextResponse.json({ success: false, error: 'Context matching identity missing.' }, { status: 400 });
    }

    const body = await request.json();
    const invoiceId = String(body?.invoiceId || '').trim();
    if (!invoiceId) {
      return NextResponse.json({ success: false, error: 'A payment reference is required.' }, { status: 400 });
    }

    const result = await fulfilUddoktaPayment(invoiceId);

    // 200 for every outcome that is not an error on our side — including 'pending' and
    // 'mismatch'. The return page renders result.outcome; an HTTP error would make the browser's
    // generic failure handling swallow a message the owner needs to read.
    return NextResponse.json({ success: true, data: result }, { status: 200 });
  } catch (err) {
    return apiError(request, err);
  }
}
