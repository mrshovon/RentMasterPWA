import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { getPaymentConfig } from '@/lib/app-settings';
import { availablePaymentMethods } from '@/lib/payments/uddoktapay';
import { apiError } from '@/lib/api-response';

// =====================================================================================
// PAYMENT SETUP — OWNER-FACING READ
// GET -> the bKash payment details an owner needs on the payment screen (QR + number +
//        instructions), plus WHICH ways they may pay. Read-only; no secrets. Lives under
//        /api/admin/ so the owner's identity is injected by middleware (any authenticated
//        owner may read it).
//
// `methods` is overwritten with availablePaymentMethods() rather than echoed from the stored
// config: the stored value is the admin's INTENT, and this route must only ever describe what
// actually works. A gateway whose key has gone missing is reported as 'manual' here, so the
// owner sees the manual form instead of a button that cannot produce a checkout link.
// =====================================================================================

export async function GET(request: NextRequest) {
  try {
    const uid = request.headers.get('x-rentmaster-uid');
    if (!uid) return NextResponse.json({ error: 'Context matching identity missing.' }, { status: 400 });

    const [config, methods] = await Promise.all([getPaymentConfig(), availablePaymentMethods()]);
    return NextResponse.json({ success: true, data: { ...config, methods } }, { status: 200 });
  } catch (err) {
    return apiError(request, err);
  }
}
