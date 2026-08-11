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

// -------------------------------------------------------------------------------------
// ANNOUNCEMENT — an admin-written popup shown to owners and tenants when they open the app.
// One announcement at a time, with a Show/Hide switch; the admin never sees it themselves (they
// have a Preview button instead), which is also what keeps them able to switch it back off.
//
// `title` and `body` are both optional: an announcement with only an image is a poster, which is
// the point of the image-only mode. `enabled` with all three empty is refused by the write route.
//
// `imageUrl` is a public URL in the existing RentMasterProDocs bucket, uploaded through
// /api/admin/uploads with folder 'announcements' — no new bucket, no base64 in this table.
//
// `updatedAt` is stamped server-side on every save and acts as the version id: the client uses it
// to tell "the same announcement I already saw" from "the admin changed it".
// -------------------------------------------------------------------------------------
export interface Announcement {
  enabled: boolean;
  title: string;
  body: string;
  imageUrl: string | null;
  updatedAt: string;   // ISO 8601, or '' when never saved
}

export const DEFAULT_ANNOUNCEMENT: Announcement = {
  enabled: false,
  title: '',
  body: '',
  imageUrl: null,
  updatedAt: '',
};

export const getAnnouncement = () => getSetting<Announcement>('announcement', DEFAULT_ANNOUNCEMENT);

// -------------------------------------------------------------------------------------
// ANALYTICS — admin-managed Google Analytics / Tag Manager wiring, so the IDs can be
// changed from the admin panel without a redeploy.
//
// IDs ONLY, deliberately. There is no "paste your snippet here" field: an arbitrary script
// stored here would be injected into every page of the app, which is stored XSS for anyone
// who ever gets hold of the admin account. Both ids are format-validated before they are
// saved (see isMeasurementId / isContainerId) and the client only ever interpolates them
// into a known Google URL.
// -------------------------------------------------------------------------------------
export interface AnalyticsConfig {
  gaMeasurementId: string;   // "G-XXXXXXX"   (GA4)
  gtmContainerId: string;    // "GTM-XXXXXXX" (Tag Manager)
  enabledWeb: boolean;       // load it in the browser / installed PWA
  enabledApp: boolean;       // load it inside the native Android shell
}

export const DEFAULT_ANALYTICS_CONFIG: AnalyticsConfig = {
  gaMeasurementId: '',
  gtmContainerId: '',
  enabledWeb: false,
  enabledApp: false,
};

// Google's own formats. Anchored, so nothing else can be smuggled into the script URL.
export const isMeasurementId = (v: string) => /^G-[A-Z0-9]{4,20}$/.test(v);
export const isContainerId = (v: string) => /^GTM-[A-Z0-9]{4,20}$/.test(v);

export const getAnalyticsConfig = () =>
  getSetting<AnalyticsConfig>('analytics_config', DEFAULT_ANALYTICS_CONFIG);

// -------------------------------------------------------------------------------------
// BREVO — admin-managed transactional email, so the account can be connected (or swapped,
// or switched off) from the admin panel without a redeploy.
//
// This is the FIRST secret ever stored in this table, and it changes the rules for it. A GA
// measurement id ships in the page source of every site that uses one; a Brevo API key sends mail
// as you. So:
//
//   * `apiKeyEnc` holds an AES-256-GCM envelope from lib/field-crypto.ts, never the key itself —
//     a database dump is then not a mail account. The `v1:` prefix makes rotation possible later.
//   * The admin GET route must NEVER return it. It returns `hasApiKey` + a masked preview, and
//     treats an empty key on write as "keep the existing one". There is no read-back path at all.
//   * There is deliberately no public `/api/app/brevo-config` counterpart, unlike analytics.
//     Nothing in the browser has any business knowing this exists.
//
// When `enabled` is false — or the key will not decrypt — every send is skipped and password
// recovery falls back to Supabase's built-in mailer, which is what shipped before this.
// -------------------------------------------------------------------------------------
export interface BrevoConfig {
  enabled: boolean;
  apiKeyEnc: string;      // encryptField(<brevo api key>), or '' when never configured
  senderEmail: string;    // must be a verified sender on the Brevo account, or sends 4xx
  senderName: string;     // the "from" name recipients see
  replyTo: string;        // optional; falls back to senderEmail
}

export const DEFAULT_BREVO_CONFIG: BrevoConfig = {
  enabled: false,
  apiKeyEnc: '',
  senderEmail: '',
  senderName: 'Bari360',
  replyTo: '',
};

export const getBrevoConfig = () => getSetting<BrevoConfig>('brevo_config', DEFAULT_BREVO_CONFIG);
