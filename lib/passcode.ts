import crypto from 'crypto';

// Tenant portal passcodes. Generated randomly (NOT derived from the phone number,
// which would be guessable). Stored only as a hash; the plaintext is shown to
// the owner once at create/reset so they can share it with the tenant.
//
// =====================================================================================
// 🔐 WHY scrypt AND NOT sha256
//
// These were stored as a plain unsalted single-round sha256 until now. That is the wrong
// primitive for this job, for one specific reason: the input space is tiny. A 6-character
// passcode over a 31-character alphabet is 31^6 ≈ 8.9x10^8 candidates — a commodity GPU walks
// the entire keyspace in seconds. And because the hash was unsalted, that work was shared:
// ONE rainbow table cracked every tenant in the database at once, with no per-row cost.
//
// scrypt fixes both halves. The per-row salt means an attacker must redo the work for every
// single tenant, and the memory-hard KDF makes each of those attempts expensive rather than free.
//
// Stored format: scrypt:<salt-b64>:<hash-b64>
//
// MIGRATION: legacy 64-hex sha256 values are still accepted by verifyPasscode(), which reports
// back whether the row needs upgrading. The login route re-hashes on the next successful sign-in,
// so tenants migrate transparently and nobody is locked out waiting for a passcode reset.
// =====================================================================================

const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no ambiguous chars (0/O, 1/I/L)

const SCRYPT_PREFIX = 'scrypt';
const SALT_BYTES = 16;
const KEY_BYTES = 32;
// N=16384 is the Node default and the usual interactive-login setting: ~16 MB and a few tens of
// milliseconds per attempt. Enough to make 8.9x10^8 guesses per tenant thoroughly impractical
// without making a legitimate login feel slow.
const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

export function generatePasscode(length = 6): string {
  const bytes = crypto.randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i++) out += ALPHABET[bytes[i] % ALPHABET.length];
  return out;
}

/** The legacy scheme: unsalted sha256 hex. Kept ONLY so old rows can still be verified. */
function legacySha256(passcode: string): string {
  return crypto.createHash('sha256').update(String(passcode).trim()).digest('hex');
}

/** True when a stored value is in the old unsalted-sha256 form (64 hex chars). */
function isLegacyHash(stored: string): boolean {
  return /^[0-9a-f]{64}$/i.test(stored);
}

/**
 * Hash a passcode for storage. Always produces the current (scrypt) format — there is no way to
 * write a legacy hash any more.
 */
export function hashPasscode(passcode: string): string {
  const salt = crypto.randomBytes(SALT_BYTES);
  const derived = crypto.scryptSync(String(passcode).trim(), salt, KEY_BYTES, SCRYPT_PARAMS);
  return `${SCRYPT_PREFIX}:${salt.toString('base64')}:${derived.toString('base64')}`;
}

/**
 * Check a passcode against a stored hash of either scheme.
 *
 * Returns `needsUpgrade: true` when the row verified against the legacy scheme, which the caller
 * should treat as "re-hash this and write it back" — that is the whole migration path. Callers
 * that ignore it are still correct, just slower to migrate.
 */
export function verifyPasscode(
  passcode: string,
  stored: string | null | undefined,
): { ok: boolean; needsUpgrade: boolean } {
  const hash = String(stored || '').trim();
  if (!hash) return { ok: false, needsUpgrade: false };

  if (isLegacyHash(hash)) {
    const candidate = Buffer.from(legacySha256(passcode), 'utf8');
    const expected = Buffer.from(hash.toLowerCase(), 'utf8');
    const ok = candidate.length === expected.length && crypto.timingSafeEqual(candidate, expected);
    return { ok, needsUpgrade: ok };
  }

  const [scheme, saltB64, keyB64] = hash.split(':');
  if (scheme !== SCRYPT_PREFIX || !saltB64 || !keyB64) return { ok: false, needsUpgrade: false };

  try {
    const salt = Buffer.from(saltB64, 'base64');
    const expected = Buffer.from(keyB64, 'base64');
    const derived = crypto.scryptSync(String(passcode).trim(), salt, expected.length, SCRYPT_PARAMS);
    const ok = derived.length === expected.length && crypto.timingSafeEqual(derived, expected);
    return { ok, needsUpgrade: false };
  } catch {
    // Malformed salt/key, or scrypt rejected the parameters. Treat as a failed login rather than
    // a 500 — a single corrupt row must not take the login route down.
    return { ok: false, needsUpgrade: false };
  }
}
