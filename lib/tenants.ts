import { decryptField } from './field-crypto';

// =====================================================================================
// 👤 TENANTS — shared response shaping for the /api/admin/tenants routes.
//
// These live here rather than in route.ts because Next.js only allows HTTP handlers (and a
// few config consts) to be exported from a route file — anything else fails the build.
// =====================================================================================

/**
 * A tenant row as the OWNER's client should see it.
 *
 * Both the list GET and the single PATCH must return this exact shape. They didn't at first:
 * the PATCH returned the raw row, which carries the nid_encrypted ciphertext and no decrypted
 * `nid` at all. The client merges a PATCH response into its state with a spread, so a missing
 * key silently preserves the stale value — an NID the owner had just saved kept reading as
 * blank until a full page reload. Hence one helper, called by both.
 */
export function shapeTenantForOwner(row: any) {
  if (!row) return row;

  const { password_hash, nid_hash, nid_encrypted, ...rest } = row;
  const nid = decryptField(nid_encrypted);

  // Ciphertext that won't decrypt is otherwise indistinguishable from "this tenant has no NID":
  // decryptField swallows the failure by design, so the field just reads blank forever. Almost
  // always a NID_ENCRYPTION_KEY that differs from the one the value was written with.
  if (nid_encrypted && nid === null) {
    console.warn(
      `[tenants] NID for ${row.id} could not be decrypted — NID_ENCRYPTION_KEY is missing or ` +
      `differs from the key this value was encrypted with.`
    );
  }

  return { ...rest, nid };
}
