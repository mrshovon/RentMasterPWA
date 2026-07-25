import crypto from 'crypto';

// =====================================================================================
// 🔐 REVERSIBLE FIELD ENCRYPTION — for data the OWNER must be able to read back.
//
// Distinct from lib/passcode.ts, which hashes: a passcode only ever needs to be *checked*, so
// one-way is right. A tenant's national ID needs to be *shown* to the owner who entered it —
// to confirm it, correct a typo, or read it off during a dispute — so it is encrypted, not
// hashed. (The NID was hashed until now, which made it permanently unreadable and therefore
// uneditable; that is the bug this module exists to fix.)
//
// AES-256-GCM: authenticated, so a tampered or truncated value fails to decrypt rather than
// returning plausible garbage. A fresh random IV per call means the same NID does not produce
// the same ciphertext twice.
//
// Stored format: v1:<iv-b64>:<tag-b64>:<ciphertext-b64>
// The version prefix is what makes a future key rotation possible without guessing at old rows.
// =====================================================================================

const VERSION = 'v1';
const IV_BYTES = 12; // 96 bits, the GCM standard

/**
 * The 32-byte key from NID_ENCRYPTION_KEY, accepted as base64 or hex.
 * Read per call rather than at module load so a serverless instance picks up a rotated value.
 */
function readKey(): Buffer | null {
  const raw = (process.env.NID_ENCRYPTION_KEY || '').trim();
  if (!raw) return null;

  // Hex first (it is also valid base64 input, so the order matters).
  const key = /^[0-9a-fA-F]{64}$/.test(raw) ? Buffer.from(raw, 'hex') : Buffer.from(raw, 'base64');
  return key.length === 32 ? key : null;
}

/** True when a usable 32-byte key is configured. Callers use this to fail loudly BEFORE writing. */
export function hasEncryptionKey(): boolean {
  return readKey() !== null;
}

/**
 * Encrypt a value for storage. Throws when no valid key is configured — the caller must catch
 * this and report it, never store nothing while telling the user it saved.
 */
export function encryptField(plain: string): string {
  const key = readKey();
  if (!key) {
    throw new Error('NID_ENCRYPTION_KEY is not configured (needs 32 bytes, base64 or hex).');
  }
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${VERSION}:${iv.toString('base64')}:${tag.toString('base64')}:${ciphertext.toString('base64')}`;
}

/**
 * Decrypt a stored value. Returns null — never throws — when the key is missing, the value is
 * malformed, or the auth tag fails. A single undecryptable row must not 500 a whole tenant list.
 */
export function decryptField(stored: string | null | undefined): string | null {
  if (!stored) return null;
  const key = readKey();
  if (!key) return null;

  try {
    const [version, ivB64, tagB64, dataB64] = String(stored).split(':');
    if (version !== VERSION || !ivB64 || !tagB64 || !dataB64) return null;

    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64'));
    decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
    const plain = Buffer.concat([
      decipher.update(Buffer.from(dataB64, 'base64')),
      decipher.final(),
    ]);
    return plain.toString('utf8');
  } catch {
    return null; // wrong key, tampered value, or a row from a previous scheme
  }
}
