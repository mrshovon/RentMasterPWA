import type { PaymentProvider } from './types';
import { getPaymentConfig } from '../app-settings';

// =====================================================================================
// MANUAL bKash provider — the owner pays into the admin-configured personal bKash
// number/QR and submits proof; a super admin verifies it in the Payments approval queue.
// =====================================================================================

export const manualBkash: PaymentProvider = {
  id: 'manual_bkash',
  label: 'bKash (manual)',
  mode: 'manual',
  async getInstructions() {
    const cfg = await getPaymentConfig();
    return {
      walletNumber: cfg.walletNumber,
      instructions: cfg.instructions,
      qrUrl: cfg.qrUrl,
    };
  },
};
