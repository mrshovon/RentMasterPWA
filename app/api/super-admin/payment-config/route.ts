import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import {
  getPaymentConfig,
  setPaymentConfig,
  DEFAULT_PAYMENT_CONFIG,
  type PaymentMethods,
} from '@/lib/app-settings';
import { currentCredentials } from '@/lib/payments/uddoktapay';
import { apiError } from '@/lib/api-response';

const METHODS: PaymentMethods[] = ['manual', 'uddoktapay', 'both'];

// =====================================================================================
// PAYMENT SETUP — ADMIN
// GET -> current bKash payment config { walletNumber, instructions, qrUrl }.
// PUT -> save it. The QR image itself is uploaded separately via /api/admin/uploads
//        (public bucket) and its URL is passed here as qrUrl.
//
// Admin-only via the /api/super-admin/* gate in middleware.ts.
// =====================================================================================

export async function GET(request: Request) {
  try {
    const config = await getPaymentConfig();
    return NextResponse.json({ success: true, data: config }, { status: 200 });
  } catch (err) {
    return apiError(request, err);
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
      methods: METHODS.includes(body.methods) ? (body.methods as PaymentMethods) : DEFAULT_PAYMENT_CONFIG.methods,
    };

    // Refuse to offer a gateway that cannot take a payment. Same guard the Brevo route applies to
    // `enabled` — the alternative is an owner clicking "Pay online" and getting a 500, which they
    // read as "this company cannot take my money" rather than "an admin missed a field".
    if (config.methods !== 'manual' && !(await currentCredentials())) {
      return NextResponse.json(
        {
          success: false,
          error:
            'Add a working UddoktaPay API key and base URL for the selected mode before offering online payment.',
        },
        { status: 400 },
      );
    }

    // setPaymentConfig encrypts the wallet number at rest; the response echoes the plaintext the
    // admin just typed, which is what the editor re-renders.
    await setPaymentConfig(config);
    return NextResponse.json({ success: true, data: config }, { status: 200 });
  } catch (err) {
    return apiError(request, err);
  }
}
