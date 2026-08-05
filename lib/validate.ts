// =============================================================================
// Shared input validation: email addresses and phone numbers.
//
// Bangladesh is the primary market (৳ currency, en-BD locale), so phone numbers get real BD
// rules — operator prefix and length — while still accepting genuine international numbers for
// anyone abroad.
//
// CANONICAL STORED FORM FOR A BD NUMBER IS THE LOCAL "01XXXXXXXXX", NOT "+8801…". That is
// what is already in the database, and tenants sign in with their phone number, so changing the
// stored shape would need a migration and would lock out anyone whose row was missed. Accepting
// every written form and normalising down to the existing one gets the validation without the
// migration. International numbers have no local form, so those are stored as "+<digits>".
//
// The frontend keeps an identical copy at rent-master-pwa-ui/lib/validate.ts — the two apps
// share no package. Edit both together. This side is the one that actually enforces: the
// frontend copy exists to give an inline error before a round trip, not to be trusted.
// =============================================================================

export interface ValidationResult {
  ok: boolean;
  /** Canonical value to store. Only meaningful when ok. */
  value: string;
  /** User-facing reason, empty when ok. */
  error: string;
}

const ok = (value: string): ValidationResult => ({ ok: true, value, error: "" });
const bad = (error: string): ValidationResult => ({ ok: false, value: "", error });

// -----------------------------------------------------------------------------
// Email
// -----------------------------------------------------------------------------

// Deliberately pragmatic rather than RFC-complete: exactly one @, no whitespace, a dot-bearing
// domain with a 2+ letter TLD. Chasing the full RFC rejects real addresses far more often than
// it catches fake ones, and the address is confirmed by actually emailing it anyway.
const EMAIL_RE = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)*\.[A-Za-z]{2,}$/;

/** 254 is the maximum length of an email address in practice (RFC 5321 path limit). */
export const MAX_EMAIL_LEN = 254;

export function validateEmail(raw: string | null | undefined, opts: { required?: boolean } = {}): ValidationResult {
  const value = String(raw ?? "").trim();
  if (!value) return opts.required ? bad("Email is required.") : ok("");
  if (value.length > MAX_EMAIL_LEN) return bad("That email address is too long.");
  if (!EMAIL_RE.test(value)) return bad("Enter a valid email address, e.g. name@example.com.");
  // Stored lowercase: Supabase treats addresses case-insensitively, and storing mixed case
  // makes "already registered" checks miss.
  return ok(value.toLowerCase());
}

/** Boolean shorthand for call sites that only need a yes/no. */
export function isValidEmail(raw: string | null | undefined): boolean {
  return validateEmail(raw, { required: true }).ok;
}

// -----------------------------------------------------------------------------
// Phone
// -----------------------------------------------------------------------------

export const BD_COUNTRY_CODE = "880";

// Every mobile operator prefix currently issued in Bangladesh:
//   013/017 Grameenphone · 014/019 Banglalink · 015 Teletalk · 016 Airtel · 018 Robi
// A number outside this set is a typo or a landline, neither of which can receive the SMS and
// WhatsApp messages this app sends.
const BD_OPERATOR_RE = /^01[3-9]\d{8}$/;

/** Local BD form: 11 digits starting 01. */
export const BD_PHONE_LEN = 11;

/**
 * Validate and canonicalise a phone number.
 *
 * Accepts, for Bangladesh: 01712345678 · +8801712345678 · 8801712345678 · 1712345678, plus any
 * of those written with spaces, dashes or brackets. All normalise to `01712345678`.
 *
 * Accepts, internationally: a leading + (or 00) followed by a non-880 country code and 8–15
 * digits total, per E.164. Normalises to `+<digits>`.
 *
 * A bare number that is neither is rejected rather than guessed at — silently treating a
 * mistyped local number as international is how bad data gets in.
 */
export function validatePhone(
  raw: string | null | undefined,
  opts: { required?: boolean } = {},
): ValidationResult {
  const input = String(raw ?? "").trim();
  if (!input) return opts.required ? bad("Phone number is required.") : ok("");

  // Keep a leading + as the only non-digit that carries meaning.
  const hadPlus = input.startsWith("+");
  let digits = input.replace(/\D/g, "");
  if (!digits) return bad("Enter a valid phone number.");

  // 00 is the other way of writing a leading +.
  let international = hadPlus;
  if (digits.startsWith("00")) {
    digits = digits.slice(2);
    international = true;
  }

  // --- Bangladesh ---------------------------------------------------------
  // Strip the country code however it was written, then the national trunk 0 may or may not
  // have been included: 8801712345678 and 88001712345678 both mean 01712345678.
  if (digits.startsWith(BD_COUNTRY_CODE)) {
    const rest = digits.slice(BD_COUNTRY_CODE.length);
    digits = rest.startsWith("0") ? rest : "0" + rest;
    international = false;
  } else if (!international && digits.length === BD_PHONE_LEN - 1 && digits.startsWith("1")) {
    // "1712345678" — the leading 0 dropped, which happens when a number is copied out of a
    // spreadsheet that treated it as a numeric cell.
    digits = "0" + digits;
  }

  if (!international) {
    if (!digits.startsWith("0")) {
      return bad("Enter a Bangladeshi number as 01XXXXXXXXX, or an international one starting with +.");
    }
    if (digits.length !== BD_PHONE_LEN) {
      return bad(`A Bangladeshi mobile number has ${BD_PHONE_LEN} digits, e.g. 01712345678.`);
    }
    if (!BD_OPERATOR_RE.test(digits)) {
      return bad("That is not a valid Bangladeshi mobile number — it should start 013–019.");
    }
    return ok(digits);
  }

  // --- International ------------------------------------------------------
  // E.164 caps the whole number, country code included, at 15 digits; nothing real is under 8.
  if (digits.length < 8 || digits.length > 15) {
    return bad("Enter a valid international number, including the country code.");
  }
  return ok("+" + digits);
}

/** Boolean shorthand. */
export function isValidPhone(raw: string | null | undefined): boolean {
  return validatePhone(raw, { required: true }).ok;
}

/**
 * Best-effort canonical form for values that are NOT being validated — display, search, and the
 * tenant-login lookup. Returns the input trimmed when it can't be parsed, so an old row in a
 * format predating this module still matches itself.
 */
export function normalizePhone(raw: string | null | undefined): string {
  const result = validatePhone(raw);
  return result.ok && result.value ? result.value : String(raw ?? "").trim();
}

/**
 * Every stored form a given number might already be sitting under, newest convention first.
 *
 * Tenants sign in by phone against an exact string match, and rows predate this validation, so
 * a lookup has to try the shapes people actually typed over the years. This is what lets the
 * canonical form change without a data migration.
 */
export function phoneLookupCandidates(raw: string | null | undefined): string[] {
  const input = String(raw ?? "").trim();
  const candidates = new Set<string>();
  if (input) candidates.add(input);

  const parsed = validatePhone(input);
  if (parsed.ok && parsed.value) {
    const canonical = parsed.value;
    candidates.add(canonical);
    // Local BD number: also try the country-coded spellings.
    if (canonical.startsWith("0") && canonical.length === BD_PHONE_LEN) {
      const national = canonical.slice(1);
      candidates.add(`+${BD_COUNTRY_CODE}${national}`);
      candidates.add(`${BD_COUNTRY_CODE}${national}`);
      candidates.add(`+${BD_COUNTRY_CODE}${canonical}`);
    }
  }
  return [...candidates];
}
