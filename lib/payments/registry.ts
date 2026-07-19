import type { PaymentProvider, PaymentProviderId } from './types';
import { manualBkash } from './manual-bkash';

// =====================================================================================
// PAYMENT PROVIDER REGISTRY — the single lookup the payment routes go through. Adding a
// real gateway later is: write a new provider file + register it here. Nothing else changes.
// =====================================================================================

const PROVIDERS: Record<PaymentProviderId, PaymentProvider> = {
  manual_bkash: manualBkash,
};

export const DEFAULT_PROVIDER_ID: PaymentProviderId = 'manual_bkash';

export function getProvider(id: PaymentProviderId = DEFAULT_PROVIDER_ID): PaymentProvider {
  return PROVIDERS[id] ?? PROVIDERS[DEFAULT_PROVIDER_ID];
}

export function listProviders(): PaymentProvider[] {
  return Object.values(PROVIDERS);
}
