import { encryptField, decryptField, hasEncryptionKey } from '../field-crypto';

// =====================================================================================
// 🔐 PAYMENT SUBMISSION FIELD ENCRYPTION
//
// A manual payment submission carries two identifiers worth protecting at rest: the mobile number
// the owner paid FROM, and the mobile-money transaction id. Together they tie a real person to a
// real financial transaction, which is exactly the pairing that makes a leaked database dump
// useful to someone.
//
// Encrypted rather than hashed because both have to be READ BACK: an admin reconciles them by eye
// against the bKash statement before approving, and the owner needs to see what they submitted.
//
// Safe to encrypt because neither column is ever queried. payment_submissions is indexed on
// owner_id, status and created_at only (ADD_PAYMENT_SUBMISSIONS.sql) — there is no index, no
// unique constraint and no search over txn_id or sender_msisdn. If a future change wants to search
// them (e.g. to block a replayed transaction id), that needs a deterministic blind index, not a
// straight column read — encryptField is randomized, so equality matching does not survive it.
// =====================================================================================

/** Thrown when a submission cannot be encrypted. The route turns it into a 400. */
export class PaymentFieldError extends Error {}

/**
 * Encrypt the two sensitive identifiers for storage.
 * @throws PaymentFieldError when no encryption key is configured — refusing is better than
 *         silently writing a payer's number and transaction id in the clear.
 */
export function encryptSubmissionFields(senderMsisdn: string, txnId: string): {
  sender_msisdn_encrypted: string;
  txn_id_encrypted: string;
} {
  if (!hasEncryptionKey()) {
    throw new PaymentFieldError(
      'Cannot record a payment: FIELD_ENCRYPTION_KEY is not configured on the server.',
    );
  }
  return {
    sender_msisdn_encrypted: encryptField(senderMsisdn),
    txn_id_encrypted: encryptField(txnId),
  };
}

/**
 * Shape a submission row for the owner or the admin queue: decrypt the identifiers back into the
 * plain `sender_msisdn` / `txn_id` keys the UI already reads, and drop the ciphertext columns.
 *
 * Used by every route that returns a submission — the owner's list, the admin queue and the
 * approve/reject response — so the responses cannot drift.
 *
 * Rows written before this change still hold plaintext in the original columns and are passed
 * through untouched, so the queue reads correctly either side of the backfill.
 */
export function shapeSubmission<T extends Record<string, any>>(row: T | null) {
  if (!row) return row;

  const { sender_msisdn_encrypted, txn_id_encrypted, sender_msisdn, txn_id, ...rest } = row as any;
  return {
    ...rest,
    sender_msisdn: decryptField(sender_msisdn_encrypted) ?? sender_msisdn ?? null,
    txn_id: decryptField(txn_id_encrypted) ?? txn_id ?? null,
  };
}
