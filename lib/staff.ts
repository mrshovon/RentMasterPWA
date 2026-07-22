import type { NextRequest } from 'next/server';
import { supabaseAdminEngine } from './supabase-server';

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
 * Normalise the editable fields off a request body. Used by POST and PATCH so the two can
 * never drift. Only keys actually present are returned, so PATCH stays a partial update.
 */
export function staffFieldsFrom(body: any): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const text = (v: any) => {
    const s = String(v ?? '').trim();
    return s === '' ? null : s;
  };
  if (body.name !== undefined) out.name = text(body.name);
  if (body.phone !== undefined) out.phone = text(body.phone);
  if (body.designation !== undefined) out.designation = text(body.designation);
  if (body.monthlySalary !== undefined) out.monthly_salary = Number(body.monthlySalary) || 0;
  if (body.joiningDate !== undefined) out.joining_date = text(body.joiningDate);
  if (body.nidNumber !== undefined) out.nid_number = text(body.nidNumber);
  if (body.nidDocUrl !== undefined) out.nid_doc_url = text(body.nidDocUrl);
  if (body.photoUrl !== undefined) out.photo_url = text(body.photoUrl);
  if (body.address !== undefined) out.address = text(body.address);
  if (body.notes !== undefined) out.notes = text(body.notes);
  if (body.isActive !== undefined) out.is_active = !!body.isActive;
  return out;
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
