import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { getPaymentConfig, setSetting, DEFAULT_PAYMENT_CONFIG } from '@/lib/app-settings';

// =====================================================================================
// PAYMENT SETUP — ADMIN
// GET -> current bKash payment config { walletNumber, instructions, qrUrl }.
// PUT -> save it. The QR image itself is uploaded separately via /api/admin/uploads
//        (public bucket) and its URL is passed here as qrUrl.
//
// Admin-only via the /api/super-admin/* gate in middleware.ts.
// =====================================================================================

export async function GET() {
  try {
    const config = await getPaymentConfig();
    return NextResponse.json({ success: true, data: config }, { status: 200 });
  } catch (err: any) {
    console.error('Payment config GET error:', err);
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}

export async function PUT(request: NextRequest) {
  try {
    const body = await request.json();
    const config = {
      provider: typeof body.provider === 'string' && body.provider.trim() ? body.provider.trim() : DEFAULT_PAYMENT_CONFIG.provider,
      walletNumber: typeof body.walletNumber === 'string' ? body.walletNumber.trim() : DEFAULT_PAYMENT_CONFIG.walletNumber,
      instructions: typeof body.instructions === 'string' ? body.instructions.trim() : DEFAULT_PAYMENT_CONFIG.instructions,
      qrUrl: body.qrUrl ? String(body.qrUrl) : null,
    };
    await setSetting('payment_config', config);
    return NextResponse.json({ success: true, data: config }, { status: 200 });
  } catch (err: any) {
    console.error('Payment config PUT error:', err);
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}
