import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { supabaseClient } from '@/lib/supabase-server';

// =====================================================================================
// 🔐 FORGOT PASSWORD — owner self-service, step 1 (public route, not behind middleware auth)
// POST { email } -> Supabase sends a recovery email whose link lands on the frontend
//                   /reset-password page. ALWAYS returns a generic 200 so the endpoint can
//                   never be used to enumerate which emails have accounts.
//
// Delivery depends on SMTP being configured in Supabase (the built-in sender is heavily
// rate-limited). The code path is correct regardless of SMTP config.
// =====================================================================================

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

// Per-identifier throttle, mirroring the login route: blunt abuse even across rotating IPs.
const MAX_ATTEMPTS = 5;
const WINDOW_MS = 15 * 60 * 1000; // 15 minutes
const attempts = new Map<string, { count: number; firstAt: number }>();

function isThrottled(key: string): boolean {
  const rec = attempts.get(key);
  if (!rec) return false;
  if (Date.now() - rec.firstAt > WINDOW_MS) { attempts.delete(key); return false; }
  return rec.count >= MAX_ATTEMPTS;
}
function record(key: string) {
  if (attempts.size > 10000) {
    const now = Date.now();
    for (const [k, v] of attempts) if (now - v.firstAt > WINDOW_MS) attempts.delete(k);
  }
  const rec = attempts.get(key);
  if (!rec || Date.now() - rec.firstAt > WINDOW_MS) attempts.set(key, { count: 1, firstAt: Date.now() });
  else rec.count += 1;
}

// Where the recovery link should send the owner. Prefer the calling frontend's Origin when it
// is on the allow-list, else the first ALLOWED_ORIGINS entry, else localhost dev.
function resolveResetUrl(request: NextRequest): string {
  const allowed = (process.env.ALLOWED_ORIGINS || '')
    .split(',').map((s) => s.trim()).filter(Boolean);
  const origin = request.headers.get('origin');
  const base =
    (origin && allowed.includes(origin) && origin) ||
    allowed[0] ||
    'http://localhost:3001';
  return `${base.replace(/\/$/, '')}/reset-password`;
}

// Generic acknowledgement — identical whether or not the email exists.
const ack = () =>
  NextResponse.json(
    { success: true, message: 'If an account exists for that email, a reset link is on its way.' },
    { status: 200, headers: cors },
  );

export async function OPTIONS() {
  return NextResponse.json({}, { headers: cors });
}

export async function POST(request: NextRequest) {
  try {
    const { email } = await request.json();
    if (!email || typeof email !== 'string' || !email.includes('@')) {
      return NextResponse.json({ success: false, error: 'A valid email is required.' }, { status: 400, headers: cors });
    }

    const key = String(email).trim().toLowerCase();
    if (isThrottled(key)) return ack(); // stay generic even when throttled — no signal to the caller
    record(key);

    // Fire the recovery email. We deliberately ignore the result: a non-existent email must
    // look identical to a real one from the outside.
    await supabaseClient.auth.resetPasswordForEmail(key, { redirectTo: resolveResetUrl(request) });

    return ack();
  } catch (err: any) {
    console.error('Forgot-password error:', err);
    // Even on internal error, do not leak specifics — return the same generic ack.
    return ack();
  }
}
