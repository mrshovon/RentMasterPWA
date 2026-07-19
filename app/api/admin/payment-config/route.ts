import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { getPaymentConfig } from '@/lib/app-settings';

// =====================================================================================
// PAYMENT SETUP — OWNER-FACING READ
// GET -> the bKash payment details an owner needs on the payment screen (QR + number +
//        instructions). Read-only; no secrets. Lives under /api/admin/ so the owner's
//        identity is injected by middleware (any authenticated owner may read it).
// =====================================================================================

export async function GET(request: NextRequest) {
  try {
    const uid = request.headers.get('x-rentmaster-uid');
    if (!uid) return NextResponse.json({ error: 'Context matching identity missing.' }, { status: 400 });

    const config = await getPaymentConfig();
    return NextResponse.json({ success: true, data: config }, { status: 200 });
  } catch (err: any) {
    console.error('Owner payment-config GET error:', err);
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}
