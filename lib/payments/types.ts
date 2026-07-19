// =====================================================================================
// PAYMENT PROVIDER ABSTRACTION
// One seam so real gateways (bKash API, SSLCommerz, Stripe) can be added later without
// reworking the approval queue. Today the only provider is 'manual_bkash': the owner pays
// into an admin-configured personal bKash number/QR and submits proof, and a super admin
// approves it by hand. A future 'gateway' provider would implement createCheckout/verifyWebhook.
// =====================================================================================

export type PaymentProviderId = 'manual_bkash'; // future: 'bkash_gateway' | 'sslcommerz' | 'stripe'

// What the owner needs on screen to complete a MANUAL payment.
export interface ManualPaymentInstructions {
  walletNumber: string;   // the bKash personal number to send to
  instructions: string;   // free-text steps shown to the owner
  qrUrl: string | null;   // public URL of the bKash QR image (Supabase Storage), or null
}

export interface PaymentContext {
  ownerId: string;
  tierId: string;
  amount: number;
}

export interface PaymentProvider {
  id: PaymentProviderId;
  label: string;
  // 'manual'  -> owner submits proof, an admin verifies (approval queue)
  // 'gateway' -> (future) redirect/checkout + webhook verification, no manual step
  mode: 'manual' | 'gateway';
  // For manual providers: the pay-to details shown on the owner's payment screen.
  getInstructions(): Promise<ManualPaymentInstructions>;
  // FUTURE (gateway): createCheckout(ctx) -> redirect URL; verifyWebhook(req) -> verified txn.
}
