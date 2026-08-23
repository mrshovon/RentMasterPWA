import type { NextRequest } from 'next/server';
import { supabaseAdminEngine } from './supabase-server';
import { validatePhone } from './validate';
import { encryptField, decryptField, hasEncryptionKey } from './field-crypto';

// =====================================================================================
// 👷 STAFF — shared helpers for the /api/admin/staff routes.
//
// These live here rather than in route.ts because Next.js only allows HTTP handlers (and a
// few config consts) to be exported from a route file — anything else fails the build.
// =====================================================================================

/** The owner id the middleware injected, or null when the request has no usable identity. */
export function ownerId(request: NextRequest): string | null {
  const id = request.headers.get('x-rentmaster-uid');
  if (!id || id === 'YOUR_ACTUAL_USER_UUID_FROM_DATABASE') return null;
  return id;
}

/** Shared by the list and single-record routes so both return the same shape. */
export const STAFF_SELECT = '*, properties:property_id ( id, name, flat_no )';

export const PAYMENT_METHODS = ['cash', 'bkash', 'nagad', 'bank', 'other'] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

/**
 * Thrown by staffFieldsFrom for a malformed field. The staff routes catch it and turn it into a
 * 400 — throwing keeps the "only present keys" shape of the return value intact, which an
 * {ok, error} wrapper would have forced every caller to unpack.
 */
export class StaffFieldError extends Error {}

/**
 * Normalise the editable fields off a request body. Used by POST and PATCH so the two can
 * never drift. Only keys actually present are returned, so PATCH stays a partial update.
 *
 * @throws StaffFieldError when a supplied value is invalid.
 */
export function staffFieldsFrom(body: any): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const text = (v: any) => {
    const s = String(v ?? '').trim();
    return s === '' ? null : s;
  };
  if (body.name !== undefined) out.name = text(body.name);
  if (body.phone !== undefined) {
    // Optional field, but the owner rings this number — an unusable one is a dead contact
    // sitting in the staff list looking like a working one.
    const parsed = validatePhone(body.phone);
    if (!parsed.ok) throw new StaffFieldError(parsed.error);
    out.phone = parsed.value || null;
  }
  if (body.designation !== undefined) out.designation = text(body.designation);
  if (body.monthlySalary !== undefined) out.monthly_salary = Number(body.monthlySalary) || 0;
  if (body.joiningDate !== undefined) out.joining_date = text(body.joiningDate);
  if (body.nidNumber !== undefined) {
    // A staff NID is a government identifier and gets the same treatment as a tenant's: encrypted
    // at rest, readable back only by the owner who entered it. It was stored in plaintext until
    // now, which was a straight inconsistency with tenants.nid_encrypted.
    //
    // Encrypted rather than hashed for the same reason as the tenant NID — the owner has to be
    // able to read it back to confirm it or fix a typo.
    const nid = text(body.nidNumber);
    if (nid && !hasEncryptionKey()) {
      // Fail loudly BEFORE the write. Storing nothing while telling the owner it saved is worse
      // than refusing, and silently falling back to plaintext would defeat the whole change.
      throw new StaffFieldError(
        'Cannot save a national ID: FIELD_ENCRYPTION_KEY is not configured on the server.',
      );
    }
    out.nid_encrypted = nid ? encryptField(nid) : null;
    // Clear any legacy plaintext on the same row. Editing a staff member is therefore also the
    // migration for that row, independent of the backfill.
    out.nid_number = null;
  }
  if (body.nidDocUrl !== undefined) out.nid_doc_url = text(body.nidDocUrl);
  if (body.photoUrl !== undefined) out.photo_url = text(body.photoUrl);
  if (body.address !== undefined) out.address = text(body.address);
  if (body.notes !== undefined) out.notes = text(body.notes);
  if (body.isActive !== undefined) out.is_active = !!body.isActive;
  return out;
}

/**
 * Shape a staff row for the owner: decrypt the NID back into `nid_number` (the key the UI already
 * reads) and drop the ciphertext column so it never reaches the browser.
 *
 * Used by EVERY route that returns a staff row — list, create, read and update — so the four
 * responses cannot drift. That drift is not hypothetical: the tenant equivalent shipped a PATCH
 * that returned the raw row while GET returned a shaped one, which is exactly the bug the comment
 * at lib/tenants.ts:13-17 records.
 *
 * Rows written before the encryption change still hold plaintext in `nid_number`; those are passed
 * through untouched, so the UI reads correctly either side of the backfill.
 */
export function shapeStaffForOwner(row: any) {
  if (!row) return row;

  const { nid_encrypted, nid_number, ...rest } = row;
  const decrypted = decryptField(nid_encrypted);

  // Ciphertext that will not decrypt is otherwise indistinguishable from "no NID on file", which
  // would quietly look like data loss. Say so in the server log; the owner still gets a usable row.
  if (nid_encrypted && decrypted === null) {
    console.warn(`[staff] nid_encrypted failed to decrypt for staff ${row.id} — wrong or rotated key?`);
  }

  return { ...rest, nid_number: decrypted ?? nid_number ?? null };
}

/**
 * Resolve the property a staff member is being attached to, proving it belongs to this owner.
 * Returns `undefined` when the caller didn't touch the field, `null` to unassign.
 * Throws when the id isn't one of the owner's properties (never trust an id from the body).
 */
export async function resolvePropertyId(body: any, uid: string): Promise<string | null | undefined> {
  if (body.propertyId === undefined) return undefined;
  const raw = String(body.propertyId ?? '').trim();
  if (!raw) return null;
  const { data: owned } = await supabaseAdminEngine
    .from('properties')
    .select('id')
    .eq('id', raw)
    .eq('owner_id', uid)
    .maybeSingle();
  if (!owned) throw new Error('That property is not yours.');
  return owned.id;
}

/** Confirm a staff row exists AND belongs to this owner. */
export async function ownsStaff(id: string, uid: string): Promise<boolean> {
  const { data } = await supabaseAdminEngine
    .from('staff')
    .select('id')
    .eq('id', id)
    .eq('owner_id', uid)
    .maybeSingle();
  return !!data;
}
