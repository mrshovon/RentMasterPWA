import { NextResponse } from 'next/server';
import { supabaseClient, supabaseAdminEngine } from '@/lib/supabase-server';
import { signTenantToken } from '@/lib/tenant-jwt';
import { isTenantLoginBlocked, TENANT_BLOCKED_MESSAGE } from '@/lib/tenant-access';
import { normalizePhone, phoneLookupCandidates } from '@/lib/validate';
import { verifyPasscode, hashPasscode } from '@/lib/passcode';

// =====================================================================================
// 🔐 UNIFIED LOGIN
// body { mode: 'owner' | 'admin' | 'tenant', ... }
//   owner/admin: { email, password }  -> Supabase auth -> returns access_token (JWT)
//   tenant:      { phone, passcode }  -> verify tenants.password_hash -> signed JWT
// =====================================================================================
const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

// ---- Per-identifier brute-force throttle (in addition to the IP rate limiter) --------
// Locks an account identifier after too many failed attempts in a rolling window. This
// blunts credential-guessing even when the attacker rotates IPs.
const MAX_FAILED_ATTEMPTS = 8;
const LOCK_WINDOW_MS = 15 * 60 * 1000; // 15 minutes
const failedAttempts = new Map<string, { count: number; firstAt: number }>();

function attemptKey(mode: string, id: string) {
  return `${mode}:${String(id).trim().toLowerCase()}`;
}
function isLockedOut(key: string): boolean {
  const rec = failedAttempts.get(key);
  if (!rec) return false;
  if (Date.now() - rec.firstAt > LOCK_WINDOW_MS) { failedAttempts.delete(key); return false; }
  return rec.count >= MAX_FAILED_ATTEMPTS;
}
function recordFailure(key: string) {
  // Bound memory: prune stale entries if the map grows large.
  if (failedAttempts.size > 10000) {
    const now = Date.now();
    for (const [k, v] of failedAttempts) if (now - v.firstAt > LOCK_WINDOW_MS) failedAttempts.delete(k);
  }
  const rec = failedAttempts.get(key);
  if (!rec || Date.now() - rec.firstAt > LOCK_WINDOW_MS) failedAttempts.set(key, { count: 1, firstAt: Date.now() });
  else rec.count += 1;
}
function clearFailures(key: string) { failedAttempts.delete(key); }

const lockedResponse = () =>
  NextResponse.json(
    { success: false, error: 'Too many failed attempts. Please wait a few minutes and try again.' },
    { status: 429, headers: cors }
  );

export async function OPTIONS() {
  return NextResponse.json({}, { headers: cors });
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const mode = body.mode;

    // ---- Owner / Admin (real Supabase auth) ----
    if (mode === 'owner' || mode === 'admin') {
      const { email, password } = body;
      if (!email || !password) {
        return NextResponse.json({ success: false, error: 'Email and password are required.' }, { status: 400, headers: cors });
      }
      const key = attemptKey('owner', email);
      if (isLockedOut(key)) return lockedResponse();

      const { data, error } = await supabaseClient.auth.signInWithPassword({ email, password });
      if (error || !data.session) {
        recordFailure(key);
        return NextResponse.json({ success: false, error: 'Invalid email or password.' }, { status: 401, headers: cors });
      }
      clearFailures(key);
      const u = data.user;
      const role = (u?.user_metadata as any)?.role || 'owner';
      return NextResponse.json({
        success: true,
        token: data.session.access_token,
        // Returned so the client can silently renew the ~1h access token and stay logged in
        // until an explicit logout (see /api/auth/refresh).
        refreshToken: data.session.refresh_token,
        expiresAt: data.session.expires_at,
        role,
        id: u?.id,
        name: (u?.user_metadata as any)?.name || u?.email || 'Owner',
      }, { status: 200, headers: cors });
    }

    // ---- Tenant (passcode against tenants.password_hash) ----
    if (mode === 'tenant') {
      const { phone, passcode } = body;
      if (!phone || !passcode) {
        return NextResponse.json({ success: false, error: 'Phone and passcode are required.' }, { status: 400, headers: cors });
      }
      // Throttle on the canonical number so 01712345678 and +8801712345678 can't be used as
      // two separate budgets against the same account.
      const key = attemptKey('tenant', normalizePhone(phone));
      if (isLockedOut(key)) return lockedResponse();

      // Rows predate phone validation and hold whatever the owner typed at the time, while the
      // tenant may type any of the spellings of their own number. Match against every form the
      // row could be under rather than migrating the column — a migration that missed a row
      // would lock that tenant out permanently, and they have no self-service recovery.
      //
      // `limit(1)` rather than maybeSingle(): tenants.phone has no unique constraint, and
      // maybeSingle() ERRORS on a duplicate, which would turn two tenants sharing a number into
      // a 500 that locks out both instead of just the second.
      const { data: matches, error } = await supabaseAdminEngine
        .from('tenants')
        .select('id, name, phone, password_hash, property_id, allow_login_unassigned')
        .in('phone', phoneLookupCandidates(phone))
        .limit(1);
      if (error) throw error;
      const tenant = matches?.[0] ?? null;

      // verifyPasscode handles both schemes: the current salted scrypt and the legacy unsalted
      // sha256 that predates it. Uniform error for "no such tenant" and "wrong passcode" (no
      // account enumeration).
      const verified = verifyPasscode(passcode, tenant?.password_hash);
      if (!tenant || !verified.ok) {
        recordFailure(key);
        return NextResponse.json({ success: false, error: 'Invalid phone or passcode.' }, { status: 401, headers: cors });
      }
      clearFailures(key);

      // Transparent hash upgrade: this row verified against the legacy unsalted sha256, so
      // re-hash it as scrypt now that we hold the plaintext. This is the entire migration path —
      // tenants move over as they sign in, with no passcode reset and no lockout. Deliberately
      // fire-and-forget: a failed upgrade must never cost this tenant their login, and the next
      // sign-in will simply try again.
      if (verified.needsUpgrade) {
        void supabaseAdminEngine
          .from('tenants')
          .update({ password_hash: hashPasscode(passcode) })
          .eq('id', tenant.id)
          .then(({ error: upgradeErr }) => {
            if (upgradeErr) console.error('Passcode hash upgrade failed:', upgradeErr.message);
          });
      }

      // Access check runs only AFTER the passcode verifies, so it can't be used to enumerate
      // accounts — and it does not count as a failed attempt, since the credentials were right.
      if (isTenantLoginBlocked(tenant)) {
        return NextResponse.json(
          { success: false, error: TENANT_BLOCKED_MESSAGE, code: 'LOGIN_BLOCKED' },
          { status: 403, headers: cors }
        );
      }
      const token = await signTenantToken(tenant.id, tenant.name);
      return NextResponse.json({ success: true, token, role: 'tenant', id: tenant.id, name: tenant.name }, { status: 200, headers: cors });
    }

    return NextResponse.json({ success: false, error: "Invalid mode. Use 'owner', 'admin' or 'tenant'." }, { status: 400, headers: cors });
  } catch (err: any) {
    console.error('Login error:', err);
    return NextResponse.json({ success: false, error: 'Login failed. Please try again.' }, { status: 500, headers: cors });
  }
}
