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

// -----------------------------------------------------------------------------
// System login identifiers (building tier)
// -----------------------------------------------------------------------------

// A building admin and the flat owners on their roster do not choose this app — they are
// enrolled into it by whoever runs their building. Asking each of them for a working email
// address is friction at the worst possible moment, and most will give one they never read.
//
// So those accounts get an identifier instead: a login string derived from where the person
// actually lives.
//
//   building admin  12a-678@bari360.com      house + last 3 of mobile
//   member owner    12a-3b-456@bari360.com   house + flat + last 3 of mobile
//
// IT IS STILL JUST THE EMAIL STRING. Login is one `signInWithPassword({ email, password })`
// call shared by every non-tenant role, `auth.users.email` is already unique, and nothing in
// the codebase rewrites it. So there is no new auth plumbing and no second source of truth —
// the identifier is stored, matched and displayed as the address it already is.
//
// Everyone else is untouched: an owner who signs up on their own keeps a real email, and
// tenants sign in with phone + passcode and have no address at all.

/**
 * ⚠️ NO HUMAN MAILBOX MAY EVER EXIST ON THIS DOMAIN. `sendEmail()` refuses to deliver here, so
 * a real staff address on it would have its mail silently dropped with nothing in the logs.
 */
export const SYSTEM_LOGIN_DOMAIN = "bari360.com";

/** Whether an address is a system-issued identifier rather than a mailbox someone reads. */
export function isSystemLogin(raw: string | null | undefined): boolean {
  return String(raw ?? "").trim().toLowerCase().endsWith("@" + SYSTEM_LOGIN_DOMAIN);
}

/** Bengali digits, so a house number typed in Bangla doesn't strip down to nothing. */
const BN_DIGITS = "০১২৩৪৫৬৭৮৯";

// "Flat 4B", "Apt. 4-B" and "#4B" are all the same flat. People write the unit word because the
// field asks for a flat, and it carries no information once it is inside an identifier.
//
// The \b is load-bearing: without it "north" matches ^no and becomes "rth".
const UNIT_WORD_RE = /^(flat|apt|apartment|unit|suite|house|holding|plot|no|number)\b[\s.#:-]*/;

/**
 * One component of an identifier, reduced to the characters that survive an email local part.
 *
 * Hyphens must die INSIDE a token, because the hyphen is what separates the components:
 * "4-B" is one flat, not two. Returns "" when nothing usable is left.
 */
function loginToken(raw: string | null | undefined): string {
  let value = String(raw ?? "").trim().toLowerCase();
  value = value.replace(/[০-৯]/g, (d) => String(BN_DIGITS.indexOf(d)));
  // Twice, so "flat no. 4b" loses both words. Not a loop — three prefixes is a typo, not intent.
  value = value.replace(UNIT_WORD_RE, "").replace(UNIT_WORD_RE, "").replace(/^#+\s*/, "");
  return value.replace(/[^a-z0-9]+/g, "").slice(0, 8);
}

/**
 * The last 3 digits of a mobile number, taken from the CANONICAL form rather than what was
 * typed. That one rule covers international numbers too: +1 555 123 4567 -> 567, the same way
 * 01712345678 -> 678, with no branch. `validatePhone` guarantees at least 8 digits.
 */
function phoneTail(raw: string | null | undefined): ValidationResult {
  const parsed = validatePhone(raw, { required: true });
  if (!parsed.ok) return parsed;
  return ok(parsed.value.replace(/\D/g, "").slice(-3));
}

/** Join the parts, add the domain, and prove the result is an address like any other. */
function composeLoginId(parts: string[], suffix: number): ValidationResult {
  const local = [...parts, suffix > 1 ? String(suffix) : ""].filter(Boolean).join("-");
  // Back through the same gate every other address passes: guarantees lowercase and the 254 cap.
  return validateEmail(`${local}@${SYSTEM_LOGIN_DOMAIN}`, { required: true });
}

/**
 * The login for the person who runs a building: house number + last 3 digits of their mobile.
 *
 * `suffix` is only for resolving a collision — 1 means none, 2 appends "-2". Callers pass it
 * when `createUser` reports the address is taken.
 *
 *   buildingAdminLoginId("12/A", "01712345678") -> 12a-678@bari360.com
 */
export function buildingAdminLoginId(
  houseNo: string | null | undefined,
  phone: string | null | undefined,
  suffix = 1,
): ValidationResult {
  const house = loginToken(houseNo);
  if (!house) return bad("The building needs a house number before logins can be generated.");

  const tail = phoneTail(phone);
  if (!tail.ok) return tail;

  return composeLoginId([house, tail.value], suffix);
}

/**
 * The login for a flat owner on a building's roster: the building's house number, their flat,
 * and the last 3 digits of their mobile.
 *
 *   memberOwnerLoginId("12/A", "Flat 3B", "01998877456") -> 12a-3b-456@bari360.com
 */
export function memberOwnerLoginId(
  houseNo: string | null | undefined,
  flatNo: string | null | undefined,
  phone: string | null | undefined,
  suffix = 1,
): ValidationResult {
  const house = loginToken(houseNo);
  if (!house) return bad("The building needs a house number before logins can be generated.");

  const flat = loginToken(flatNo);
  if (!flat) return bad("Enter the flat number — it becomes part of the owner's login.");

  const tail = phoneTail(phone);
  if (!tail.ok) return tail;

  return composeLoginId([house, flat, tail.value], suffix);
}

/** The normalised flat token, stored beside the free-text label so the two never disagree. */
export function flatToken(raw: string | null | undefined): string {
  return loginToken(raw);
}
