import { NextResponse } from 'next/server';
import { supabaseClient, supabaseAdminEngine } from '@/lib/supabase-server';
import { signTenantToken } from '@/lib/tenant-jwt';
import { isTenantLoginBlocked, TENANT_BLOCKED_MESSAGE } from '@/lib/tenant-access';
import crypto from 'crypto';

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
      const key = attemptKey('tenant', phone);
      if (isLockedOut(key)) return lockedResponse();

      const { data: tenant, error } = await supabaseAdminEngine
        .from('tenants')
        .select('id, name, phone, password_hash, property_id, allow_login_unassigned')
        .eq('phone', String(phone).trim())
        .maybeSingle();
      if (error) throw error;

      const hash = crypto.createHash('sha256').update(String(passcode).trim()).digest('hex');
      // Uniform error for "no such tenant" and "wrong passcode" (no account enumeration).
      if (!tenant || hash !== tenant.password_hash) {
        recordFailure(key);
        return NextResponse.json({ success: false, error: 'Invalid phone or passcode.' }, { status: 401, headers: cors });
      }
      clearFailures(key);

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
