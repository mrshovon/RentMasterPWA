import { supabaseAdminEngine } from './supabase-server';
import { encryptField, decryptField, hasEncryptionKey } from './field-crypto';

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

/**
 * How payment_config is actually stored. `walletNumberEnc` holds the encrypted number; the
 * plaintext `walletNumber` is only present on rows written before the encryption change and is
 * read as a fallback so the payment screen keeps working across the migration.
 *
 * Encrypted rather than hashed because owners have to READ it — it is the number they pay into.
 * Safe to encrypt because app_settings is a key/value singleton store that is never queried by
 * value, only by `key`.
 */
interface StoredPaymentConfig extends Omit<PaymentConfig, 'walletNumber'> {
  walletNumber?: string;
  walletNumberEnc?: string;
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

/**
 * The payment config with the wallet number decrypted, which is what every caller wants — the
 * owner payment screen, the manual-bKash provider and the admin editor all read `walletNumber`.
 * Decrypting in one place means no caller has to know the field is encrypted at rest.
 */
export async function getPaymentConfig(): Promise<PaymentConfig> {
  const stored = await getSetting<StoredPaymentConfig>('payment_config', DEFAULT_PAYMENT_CONFIG);
  const { walletNumberEnc, ...rest } = stored;
  return {
    ...DEFAULT_PAYMENT_CONFIG,
    ...rest,
    walletNumber: decryptField(walletNumberEnc) ?? stored.walletNumber ?? '',
  };
}

/**
 * Write the payment config, encrypting the wallet number. The plaintext key is explicitly cleared
 * so a pre-migration value cannot linger next to the ciphertext and quietly become the one that
 * gets read back.
 * @throws when no encryption key is configured — better to refuse than to store the number
 *         admins collect real money on in the clear.
 */
export async function setPaymentConfig(config: PaymentConfig): Promise<void> {
  const { walletNumber, ...rest } = config;
  const trimmed = (walletNumber || '').trim();
  if (trimmed && !hasEncryptionKey()) {
    throw new Error('Cannot save the wallet number: FIELD_ENCRYPTION_KEY is not configured.');
  }
  await setSetting('payment_config', {
    ...rest,
    walletNumber: '',
    walletNumberEnc: trimmed ? encryptField(trimmed) : '',
  } satisfies StoredPaymentConfig);
}

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
// LEGAL DOCUMENT VERSION — which edition of the Terms and Privacy Policy is currently published.
//
// Stored here rather than hardcoded so the version can be bumped when the documents change
// without a redeploy, the same way `default_signup_tier` is set from the admin console.
//
// The signup form fetches this, shows the matching documents, and echoes the version back on
// submit, so what lands in `terms_acceptances.version` is the edition the person was actually
// shown — not whatever the server happened to consider current a moment later.
//
// The default is the date the first edition was published. A date is used rather than a number
// because it matches the "Effective date" printed at the top of the documents themselves, so a
// stored value can be traced to a specific text.
// -------------------------------------------------------------------------------------
export const DEFAULT_TERMS_VERSION = '2026-08-15';

export const getTermsVersion = async (): Promise<string> => {
  const { version } = await getSetting<{ version: string }>('terms_version', {
    version: DEFAULT_TERMS_VERSION,
  });
  return (version || '').trim() || DEFAULT_TERMS_VERSION;
};

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

// -------------------------------------------------------------------------------------
// LEGAL DOCUMENTS — admin-editable Terms and Privacy Policy.
//
// The authored markdown in ../legal/ is compiled into the frontend at build time
// (scripts/build-legal.mjs -> content/legal/generated.ts) and stays the BUILT-IN FALLBACK. What
// is stored here is an override: saved markdown that the public pages render instead. Nothing is
// stored until an admin saves, and clearing a key restores the compiled text.
//
// The fallback is the whole safety design. Google Play requires the privacy URL to resolve, and
// a settings hiccup must never leave /privacy or /terms with nothing to show — so a missing row,
// a failed read and an empty string all mean "use the compiled document", never an error page.
//
// ONE KEY PER DOCUMENT AND LANGUAGE rather than one blob: the Bangla Terms alone are 62 KB, and
// a public page should fetch only the edition it is about to render.
//
// The markdown is stored RAW and parsed in the browser by lib/legal-markdown.mjs — the same
// functions that produced the compiled fallback. The backend deliberately does not parse: a
// second parser here is how the saved text and the compiled text would come to render
// differently, which for a legal document is the one failure that matters.
// -------------------------------------------------------------------------------------
export type LegalDocName = 'privacy' | 'terms';
export type LegalLang = 'en' | 'bn';

export const LEGAL_DOC_NAMES: LegalDocName[] = ['privacy', 'terms'];
export const LEGAL_LANGS: LegalLang[] = ['en', 'bn'];

/** Guards against an arbitrary settings key being reachable through a query parameter. */
export function legalSettingKey(doc: LegalDocName, lang: LegalLang): string {
  return `legal_${doc}_${lang}`;
}

export interface LegalDocSetting {
  /** The admin's markdown. '' means "no override" — fall back to the compiled document. */
  markdown: string;
  /** ISO 8601, stamped server-side on every save. '' when never saved. */
  updatedAt: string;
}

export const DEFAULT_LEGAL_DOC: LegalDocSetting = { markdown: '', updatedAt: '' };

export const getLegalDoc = (doc: LegalDocName, lang: LegalLang) =>
  getSetting<LegalDocSetting>(legalSettingKey(doc, lang), DEFAULT_LEGAL_DOC);

/**
 * Publish (or clear) one document. `markdown` of '' clears the override.
 *
 * A size ceiling is enforced by the caller, not here — see the route. These documents are tens of
 * kilobytes by nature, so the usual short-string caps elsewhere in this file do not apply.
 */
export const setLegalDoc = (doc: LegalDocName, lang: LegalLang, markdown: string) =>
  setSetting(legalSettingKey(doc, lang), {
    markdown,
    updatedAt: markdown ? new Date().toISOString() : '',
  } satisfies LegalDocSetting);

/**
 * The counterpart getTermsVersion() never had.
 *
 * Until now nothing in either repo wrote `terms_version` — it could only be changed by hand-run
 * SQL, which is why the recorded edition has always been the hardcoded default. Editing the Terms
 * without being able to stamp a new effective date would leave every consent record pointing at
 * a version whose wording had silently changed underneath it.
 *
 * Empty restores DEFAULT_TERMS_VERSION rather than storing a blank, because a blank version on a
 * consent row is worse than a stale one.
 */
export const setTermsVersion = (version: string) =>
  setSetting('terms_version', { version: (version || '').trim() || DEFAULT_TERMS_VERSION });
