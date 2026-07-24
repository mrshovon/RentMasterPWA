import { supabaseAdminEngine } from './supabase-server';

// =====================================================================================
// APP SETTINGS — tiny key/value store for platform-wide admin config (app_settings table).
// Service-role only (the table is RLS deny-all). See ADD_APP_SETTINGS.sql.
// =====================================================================================

export interface PaymentConfig {
  provider: string;       // which MFS the number/QR belongs to (bKash, Nagad, Rocket, …)
  walletNumber: string;   // the MFS personal number owners pay into
  instructions: string;   // steps shown on the owner payment screen
  qrUrl: string | null;   // public URL of the QR image in the payment-assets bucket
}

export const DEFAULT_PAYMENT_CONFIG: PaymentConfig = {
  provider: 'bKash',
  walletNumber: '',
  instructions: '',
  qrUrl: null,
};

// Read one settings row's JSON value. Returns `fallback` when the row is missing.
export async function getSetting<T>(key: string, fallback: T): Promise<T> {
  const { data, error } = await supabaseAdminEngine
    .from('app_settings')
    .select('value')
    .eq('key', key)
    .maybeSingle();
  if (error || !data) return fallback;
  return (data.value ?? fallback) as T;
}

// Upsert one settings row's JSON value.
export async function setSetting(key: string, value: unknown): Promise<void> {
  const { error } = await supabaseAdminEngine
    .from('app_settings')
    .upsert({ key, value, updated_at: new Date().toISOString() }, { onConflict: 'key' });
  if (error) throw error;
}

export const getPaymentConfig = () => getSetting<PaymentConfig>('payment_config', DEFAULT_PAYMENT_CONFIG);

// -------------------------------------------------------------------------------------
// MAINTENANCE MODE — admin-declared downtime window. When enabled, owners and tenants get a
// blocking modal on app open; the super-admin is never blocked (they have to be able to turn
// it back off). Times are ISO 8601 strings, or null for "no stated start/end".
// -------------------------------------------------------------------------------------
export interface MaintenanceMode {
  enabled: boolean;
  startAt: string | null;
  endAt: string | null;
  message: string;
}

export const DEFAULT_MAINTENANCE_MODE: MaintenanceMode = {
  enabled: false,
  startAt: null,
  endAt: null,
  message: '',
};

export const getMaintenanceMode = () =>
  getSetting<MaintenanceMode>('maintenance_mode', DEFAULT_MAINTENANCE_MODE);

// The tier id given to newly self-signed-up owners. Empty/absent => implicit free (no history row).
export const getDefaultSignupTier = () => getSetting<{ tierId: string }>('default_signup_tier', { tierId: '' });
