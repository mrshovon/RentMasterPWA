// Whether a tenant is allowed to reach the resident portal.
//
// An unassigned tenant (no property — moved out, between flats) is blocked by default; the owner
// can grant a per-tenant exception via `allow_login_unassigned`. Assigned tenants always pass.
//
// Enforced in two places: the tenant branch of /api/auth/login (blocks new sign-ins) and
// /api/admin/tenants/me (evicts a tenant who is already holding a valid 7-day JWT, since those
// are verified by signature alone and carry no revocation).

export interface TenantAccessFields {
  property_id: string | null;
  allow_login_unassigned?: boolean | null;
}

export function isTenantLoginBlocked(tenant: TenantAccessFields): boolean {
  return tenant.property_id == null && !tenant.allow_login_unassigned;
}

export const TENANT_BLOCKED_MESSAGE =
  'Your account is not linked to a property right now. Please contact your landlord.';
