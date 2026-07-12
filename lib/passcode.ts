import crypto from 'crypto';

// Tenant portal passcodes. Generated randomly (NOT derived from the phone number,
// which would be guessable). Stored only as a sha256 hash; the plaintext is shown to
// the owner once at create/reset so they can share it with the tenant.
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no ambiguous chars (0/O, 1/I/L)

export function generatePasscode(length = 6): string {
  const bytes = crypto.randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i++) out += ALPHABET[bytes[i] % ALPHABET.length];
  return out;
}

export function hashPasscode(passcode: string): string {
  return crypto.createHash('sha256').update(String(passcode).trim()).digest('hex');
}
