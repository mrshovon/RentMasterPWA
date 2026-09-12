import crypto from 'crypto';
import { deriveSubKey } from '../field-crypto';

// =====================================================================================
// 🔏 THE SIGNED CANCEL LINK
//
// WHY THIS EXISTS. The gateway's cancel_url is opened by whatever browser the payer happens to be
// in, and on Android that is emphatically NOT our app: Capacitor punts any off-origin navigation to
// Chrome, so the whole payment happens there. Chrome has its own localStorage, so the session the
// app holds simply does not exist on that page — the cancel call could not authenticate, and
// rentMasterFetch's "no token" path would bounce the payer to the login screen before they even
// read "Payment cancelled".
//
// So the link carries its own authority. The checkout route signs the submission id; the public
// cancel route verifies the signature and will act on that submission and no other. No session,
// no cookie, no bearer token — it works in the app, in Chrome, in a Custom Tab, anywhere.
//
// ⭐ WHAT THE SIGNATURE IS AND IS NOT PROTECTING.
// It is NOT protecting money: the cancel route's UPDATE is still guarded on
// `gateway_invoice_id is null`, so a payment that has been bound to a gateway invoice cannot be
// cancelled by anyone, signature or not. What it protects is one owner's ability to cancel
// ANOTHER owner's pending attempt — without it, the submission id alone (a uuid in a URL, which
// lands in browser history and referrer headers) would be enough.
//
// The token is therefore deliberately NOT an expiring one. A payer who leaves the tab open for an
// hour and then backs out should still be able to; expiry would buy nothing, because the worst a
// replayed token can do is re-cancel an already-cancelled row, which matches zero rows.
// =====================================================================================

/** Domain separator. Changing this string invalidates every link already in flight. */
const LABEL = 'uddoktapay-cancel-v1';

/** Truncated to 128 bits: a MAC, not a hash — full width buys nothing and doubles the URL noise. */
const SIG_BYTES = 16;

function sign(submissionId: string): string | null {
  const key = deriveSubKey(LABEL);
  if (!key) return null;
  return crypto
    .createHmac('sha256', key)
    .update(submissionId, 'utf8')
    .digest('base64url')
    .slice(0, Math.ceil((SIG_BYTES * 8) / 6));
}

/**
 * The query string to hang off cancel_url, including the leading '?'. Empty when no encryption key
 * is configured — the caller then ships an unsigned cancel_url, and the page falls back to the
 * authenticated route. A missing key must degrade the feature, never break checkout.
 */
export function cancelQuery(submissionId: string): string {
  const sig = sign(submissionId);
  if (!sig) return '';
  return `?ref=${encodeURIComponent(submissionId)}&sig=${encodeURIComponent(sig)}`;
}

/**
 * True when `sig` is this submission's signature.
 *
 * timingSafeEqual on equal-length buffers, so a caller cannot learn the correct signature byte by
 * byte from response timings. The length check happens first because timingSafeEqual THROWS on a
 * length mismatch rather than returning false.
 */
export function verifyCancelSignature(submissionId: string, sig: string): boolean {
  const expected = sign(submissionId);
  if (!expected || !sig) return false;
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(sig, 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}
