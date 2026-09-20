import { supabaseAdminEngine } from './supabase-server';
import { encryptField, decryptField, hasEncryptionKey } from './field-crypto';
import { FONT_ID_RE, fontFormatFor, isSafeFontUrl, type FontFormat } from './font-validate';

// =====================================================================================
// APP SETTINGS — tiny key/value store for platform-wide admin config (app_settings table).
// Service-role only (the table is RLS deny-all). See ADD_APP_SETTINGS.sql.
// =====================================================================================

/**
 * Which ways an owner may pay. Deliberately ONE switch rather than a selector here plus an
 * `enabled` flag on the gateway config: two toggles answering one question is how a config ends
 * up in a state nobody can explain ("it's enabled but not offered?"). Turning UddoktaPay off IS
 * `methods: 'manual'`.
 *
 * The gateway's credentials live separately (see UddoktaPayConfig) so they can be entered and
 * tested before anyone is sent to them.
 */
export type PaymentMethods = 'manual' | 'uddoktapay' | 'both';

export interface PaymentConfig {
  provider: string;       // which MFS the number/QR belongs to (bKash, Nagad, Rocket, …)
  walletNumber: string;   // the MFS personal number owners pay into
  instructions: string;   // steps shown on the owner payment screen
  qrUrl: string | null;   // public URL of the QR image in the payment-assets bucket
  methods: PaymentMethods;
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
  // 'manual' is the safe default in both directions: it is what every existing install already
  // does, and a fresh install cannot accidentally offer a gateway it has no keys for.
  methods: 'manual',
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
// POPUPS — the admin-written modals, in two places: on app open for signed-in owners and
// tenants (`announcement`), and on the signed-out sign-in screen on a phone (`login_popup`).
//
// ONE SHAPE FOR BOTH, because they differ in exactly one thing — where they are shown — and that
// difference lives in the two gates, not in the data. They are edited side by side in the same
// settings tab, so two near-identical shapes would drift in precisely the details a reader notices.
//
// A LIST, not one item. The admin runs several at once — an Eid notice beside a payment change, two
// banners on the sign-in screen — and each carries its own `active` switch. There is deliberately
// NO master on/off on the set: "no active items" already means "nothing shows", and a second switch
// that can disagree with the first is a support question waiting to happen.
//
// `id` is server-assigned and stable. Reorder and delete key on it, so an edit that changes every
// other field still refers to the same item.
//
// `imageUrl` is a public URL in the existing RentMasterProDocs bucket, uploaded through
// /api/admin/uploads — no new bucket, no base64 in this table.
//
// `updatedAt` is stamped server-side on every save and acts as the version id for the whole set:
// the gates use it to tell "the same popups I already saw" from "the admin changed something".
// -------------------------------------------------------------------------------------
export interface PopupItem {
  id: string;
  active: boolean;
  titleEn: string;
  titleBn: string;
  bodyEn: string;
  bodyBn: string;
  imageUrl: string | null;
}

export interface PopupSet {
  items: PopupItem[];
  updatedAt: string;   // ISO 8601, or '' when never saved
}

export const DEFAULT_POPUP_SET: PopupSet = { items: [], updatedAt: '' };

/** Everything a caller may hand us for one item, before it has been through normalisePopupItem. */
type RawPopupItem = Partial<PopupItem> & {
  // The pre-list single-object shapes, for the migration below.
  title?: string;
  body?: string;
  enabled?: boolean;
};

const str = (v: unknown) => String(v ?? '').trim();

/**
 * One item, with every field forced to the right type.
 *
 * Also the LEGACY BRIDGE: the single-object announcement had `title`/`body` and no language split,
 * so those fold into the English edition. Nothing in production carries that shape today, but a row
 * written between now and the deploy would, and silently dropping what the admin typed is worse
 * than a few lines of defensiveness.
 */
export function normalisePopupItem(raw: RawPopupItem, fallbackId: string): PopupItem {
  return {
    id: str(raw.id) || fallbackId,
    // Legacy `enabled` becomes `active`; a legacy row with neither stays hidden rather than
    // surprising everyone by appearing the moment this deploys.
    active: raw.active === undefined ? !!raw.enabled : !!raw.active,
    titleEn: str(raw.titleEn ?? raw.title),
    titleBn: str(raw.titleBn),
    bodyEn: str(raw.bodyEn ?? raw.body),
    bodyBn: str(raw.bodyBn),
    imageUrl: raw.imageUrl ? String(raw.imageUrl) : null,
  };
}

/** True when an item would render as a blank modal — no words in either language, no picture. */
export const isPopupEmpty = (i: PopupItem) =>
  !i.titleEn && !i.titleBn && !i.bodyEn && !i.bodyBn && !i.imageUrl;

/**
 * Read a popup set, tolerating the pre-list shape.
 *
 * A stored value with no `items` array is the old single object. It is wrapped into a one-item list
 * rather than discarded, so the admin's words survive the shape change.
 */
async function getPopupSet(key: string): Promise<PopupSet> {
  const stored = await getSetting<PopupSet & RawPopupItem>(key, DEFAULT_POPUP_SET as PopupSet & RawPopupItem);

  if (Array.isArray(stored?.items)) {
    return {
      items: stored.items.map((i, n) => normalisePopupItem(i, `${key}-${n}`)),
      updatedAt: str(stored.updatedAt),
    };
  }

  // Legacy single object. An entirely empty one is just "never configured".
  const one = normalisePopupItem(stored || {}, `${key}-0`);
  if (isPopupEmpty(one)) return { items: [], updatedAt: str(stored?.updatedAt) };
  return { items: [one], updatedAt: str(stored?.updatedAt) };
}

export const ANNOUNCEMENT_KEY = 'announcement';
export const LOGIN_POPUP_KEY = 'login_popup';

export const getAnnouncements = () => getPopupSet(ANNOUNCEMENT_KEY);
export const getLoginPopups = () => getPopupSet(LOGIN_POPUP_KEY);

/** Only what the public may see: the active items, in order, with the rest gone entirely. */
export const activePopups = (set: PopupSet): PopupSet => ({
  items: set.items.filter((i) => i.active),
  updatedAt: set.updatedAt,
});

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
// FONTS — the typeface the whole app renders in, for both scripts, set from the admin panel.
//
// Two slots, because this app has two: `body` drives Tailwind's font-sans (which sits on
// <body> and therefore reaches everything), `heading` drives font-display (banner titles,
// metric values, hub-tile labels). One slot would have left the most prominent text in the
// app unmoved when the admin changed the font, which reads as a broken feature.
//
// Each slot names a LATIN face and a BENGALI face. There is no :lang() rule and no coupling
// to the language toggle: Bengali codepoints are absent from Latin faces, so a single stack
// ("Inter", "Hind Siliguri", ui-sans-serif) splits itself per glyph. That is the only
// approach that renders a MIXED string correctly, and this app is full of them — every money
// figure is a Bengali ৳ (U+09F3) followed by Western digits, in both languages, by the
// decision recorded in lib/format.ts.
//
// WHAT IS STORED IS IDS, not family names. The catalogue of real families lives in the UI
// repo (lib/font-catalog.ts), which is the only place that builds CSS; here we keep the id
// allow-list so a family that is not on it can never be saved. If the two drift, the
// frontend treats an id it does not know as "unset" — drift can make a font unavailable, it
// can never make one unsafe.
//
// A CUSTOM face is a URL plus a format, declared under one of the four fixed family names in
// lib/font-validate.ts. The admin never supplies a family name, so there is nothing to
// sanitise: `font-family` can only ever be a string we wrote.
// -------------------------------------------------------------------------------------

/** A face the admin supplied — uploaded to our bucket, or a pasted https URL. */
export interface CustomFont {
  url: string;              // https, validated by isSafeFontUrl()
  format: FontFormat;       // derived server-side from the URL, never taken from the body
  originalName: string;     // for the admin UI only; NEVER interpolated into CSS
}

/** One typographic slot: what to use for Latin, what for Bengali, plus optional custom faces. */
export interface FontSlot {
  latinId: string;              // catalogue id, or '' to leave the built-in default
  banglaId: string;             // catalogue id, or '' to leave the built-in default
  customLatin: CustomFont | null;   // takes precedence over latinId
  customBangla: CustomFont | null;  // takes precedence over banglaId
}

export interface FontConfig {
  body: FontSlot;
  heading: FontSlot;
  /** ISO 8601, stamped on save. '' when never configured. Doubles as the client cache key. */
  updatedAt: string;
}

const EMPTY_FONT_SLOT: FontSlot = { latinId: '', banglaId: '', customLatin: null, customBangla: null };

/** Nothing configured = exactly what the app rendered before this feature existed. */
export const DEFAULT_FONT_CONFIG: FontConfig = {
  body: { ...EMPTY_FONT_SLOT },
  heading: { ...EMPTY_FONT_SLOT },
  updatedAt: '',
};

/**
 * The ids the UI catalogue offers. Ids only — see the note above.
 * Mirror of LATIN_FONTS / BANGLA_FONTS in rent-master-pwa-ui/lib/font-catalog.ts.
 */
export const CURATED_LATIN_IDS = new Set([
  'inter', 'roboto', 'open-sans', 'lato', 'montserrat', 'poppins', 'nunito-sans',
  'work-sans', 'source-sans-3', 'dm-sans', 'figtree', 'outfit', 'rubik', 'public-sans',
  'plus-jakarta-sans', 'manrope', 'merriweather', 'lora',
]);

export const CURATED_BANGLA_IDS = new Set([
  'shadhinata-2', 'noto-sans-bengali', 'noto-serif-bengali', 'anek-bangla',
  'hind-siliguri', 'baloo-da-2', 'atma', 'mina', 'tiro-bangla',
]);

/** Coerce anything a caller sends into a CustomFont, or null. Fails closed. */
function normaliseCustomFont(raw: unknown): CustomFont | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Partial<CustomFont>;
  if (!isSafeFontUrl(r.url)) return null;
  const format = fontFormatFor(r.url);
  if (!format) return null;
  return {
    url: r.url,
    // Derived here, never trusted from the request: the format token goes straight into CSS.
    format,
    originalName: String(r.originalName || '').slice(0, 120),
  };
}

/** Coerce one slot. An id that is not in the allow-list is dropped, not rejected. */
function normaliseFontSlot(raw: unknown, allowedLatin: Set<string>, allowedBangla: Set<string>): FontSlot {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Partial<FontSlot>;
  const pick = (v: unknown, allowed: Set<string>) => {
    const s = String(v || '').trim().toLowerCase();
    return FONT_ID_RE.test(s) && allowed.has(s) ? s : '';
  };
  return {
    latinId: pick(r.latinId, allowedLatin),
    banglaId: pick(r.banglaId, allowedBangla),
    customLatin: normaliseCustomFont(r.customLatin),
    customBangla: normaliseCustomFont(r.customBangla),
  };
}

/** Normalise a whole config off the wire. Everything invalid becomes "unset". */
export function normaliseFontConfig(raw: unknown): FontConfig {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Partial<FontConfig>;
  return {
    body: normaliseFontSlot(r.body, CURATED_LATIN_IDS, CURATED_BANGLA_IDS),
    heading: normaliseFontSlot(r.heading, CURATED_LATIN_IDS, CURATED_BANGLA_IDS),
    updatedAt: '',
  };
}

/** True when the config is indistinguishable from "never configured". */
export function isDefaultFontConfig(c: FontConfig): boolean {
  const empty = (s: FontSlot) => !s.latinId && !s.banglaId && !s.customLatin && !s.customBangla;
  return empty(c.body) && empty(c.heading);
}

export const getFontConfig = () => getSetting<FontConfig>('font_config', DEFAULT_FONT_CONFIG);

/**
 * Write the config, stamping updatedAt. Resetting to the default clears the stamp too, so a
 * client that has cached a configuration can tell "back to default" from "never set" — both
 * mean the same thing to the renderer, which is the point.
 */
export async function setFontConfig(next: FontConfig): Promise<FontConfig> {
  const stored: FontConfig = {
    ...next,
    updatedAt: isDefaultFontConfig(next) ? '' : new Date().toISOString(),
  };
  await setSetting('font_config', stored);
  return stored;
}

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
// UDDOKTAPAY — the hosted payment gateway (a Paymently install). The SECOND secret in this
// table, and it follows every rule Brevo established above, for the same reason: this key can
// move money and issue refunds on the account.
//
//   * Both keys are `*Enc` envelopes. The field NAMES are load-bearing — a `...cfg` spread into
//     a response body cannot leak something called `liveApiKeyEnc` by accident the way it could
//     leak `apiKey`.
//   * The admin GET route returns a masked preview and booleans, never a key. Empty on write
//     means "keep", not "clear", because the form cannot show what it never received.
//   * There is NO /api/app/ counterpart. Nothing in a browser needs to know this exists.
//
// SANDBOX AND LIVE ARE TWO SEPARATE CREDENTIAL PAIRS, not one pair plus a flag. They are
// genuinely different accounts with different keys, and keeping both stored means flipping
// `mode` to test something does not destroy the live key — which is exactly the mistake a single
// pair invites at the worst possible moment.
//
// The base URLs are configurable rather than hard-coded because a Paymently install lives on the
// customer's own domain (ours is bari360.paymently.io); there is no single vendor endpoint.
// -------------------------------------------------------------------------------------
export interface UddoktaPayConfig {
  mode: 'sandbox' | 'live';
  sandboxBaseUrl: string;
  sandboxApiKeyEnc: string;
  liveBaseUrl: string;
  liveApiKeyEnc: string;
}

export const DEFAULT_UDDOKTAPAY_CONFIG: UddoktaPayConfig = {
  // Sandbox by default. A fresh install that somehow reached a checkout should hit the test
  // gateway, not charge a real card.
  mode: 'sandbox',
  // UddoktaPay's shared demo environment, with a publicly documented test key.
  sandboxBaseUrl: 'https://sandbox.uddoktapay.com/api',
  sandboxApiKeyEnc: '',
  liveBaseUrl: '',
  liveApiKeyEnc: '',
};

export const getUddoktaPayConfig = () =>
  getSetting<UddoktaPayConfig>('uddoktapay_config', DEFAULT_UDDOKTAPAY_CONFIG);

/**
 * Write the gateway config, encrypting whichever keys were supplied.
 *
 * `sandboxApiKey`/`liveApiKey` are RAW keys and are optional: omitted or empty means "leave the
 * stored one alone". That is what makes the write-only form work — the admin can change the mode
 * or a base URL without re-typing a key they cannot see.
 *
 * @throws when a key was supplied but no encryption key is configured. Storing a payment
 *         credential in the clear while reporting success is the worst of both outcomes.
 */
export async function setUddoktaPayConfig(
  next: Omit<UddoktaPayConfig, 'sandboxApiKeyEnc' | 'liveApiKeyEnc'>,
  keys: { sandboxApiKey?: string; liveApiKey?: string } = {},
): Promise<void> {
  const current = await getUddoktaPayConfig();
  const sandboxRaw = (keys.sandboxApiKey || '').trim();
  const liveRaw = (keys.liveApiKey || '').trim();

  if ((sandboxRaw || liveRaw) && !hasEncryptionKey()) {
    throw new Error(
      'Cannot save the API key: FIELD_ENCRYPTION_KEY is not configured on the server.',
    );
  }

  await setSetting('uddoktapay_config', {
    ...DEFAULT_UDDOKTAPAY_CONFIG,
    ...next,
    sandboxApiKeyEnc: sandboxRaw ? encryptField(sandboxRaw) : current.sandboxApiKeyEnc,
    liveApiKeyEnc: liveRaw ? encryptField(liveRaw) : current.liveApiKeyEnc,
  } satisfies UddoktaPayConfig);
}

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
// 'about' rides this pipeline rather than getting its own: it is the same problem (a long
// bilingual document the admin must be able to edit without a deploy) and a second mechanism would
// be a second thing to keep working. It is NOT consented-to, though — see terms_version below,
// which About deliberately does not touch.
export type LegalDocName = 'privacy' | 'terms' | 'about';
export type LegalLang = 'en' | 'bn';

export const LEGAL_DOC_NAMES: LegalDocName[] = ['privacy', 'terms', 'about'];
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
