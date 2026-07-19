import { NextResponse } from 'next/server';
import { supabaseClient, supabaseAdminEngine } from '@/lib/supabase-server';
import { getDefaultSignupTier } from '@/lib/app-settings';
import { activateSubscription } from '@/lib/payments/activate';

// =====================================================================================
// 🔐 OWNER SELF-SIGNUP — public route (not behind middleware auth, like login/forgot).
// POST { name, email, phone, password } -> creates an auto-confirmed owner, applies the
// admin-configured default plan (free unless changed), and returns a session token so the
// new owner lands straight on /owner.
//
// FUTURE SCOPE (not built): require email verification instead of email_confirm:true, once
// custom SMTP is configured in Supabase. Flip the createUser flag + add a verify-link flow.
// =====================================================================================
const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

// Per-identifier throttle, mirroring the forgot-password route: blunt abuse across rotating IPs.
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

export async function OPTIONS() {
  return NextResponse.json({}, { headers: cors });
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const name = String(body.name || '').trim();
    const email = String(body.email || '').trim();
    const phone = String(body.phone || '').trim();
    const password = String(body.password || '');

    if (!email || !email.includes('@')) {
      return NextResponse.json({ success: false, error: 'A valid email is required.' }, { status: 400, headers: cors });
    }
    if (password.length < 8) {
      return NextResponse.json({ success: false, error: 'Password must be at least 8 characters.' }, { status: 400, headers: cors });
    }
    if (!name) {
      return NextResponse.json({ success: false, error: 'Your name is required.' }, { status: 400, headers: cors });
    }

    const key = email.toLowerCase();
    if (isThrottled(key)) {
      return NextResponse.json({ success: false, error: 'Too many attempts. Please wait a few minutes and try again.' }, { status: 429, headers: cors });
    }
    record(key);

    // Create the auth user (auto-confirmed). Owners always get role 'owner' (never 'admin').
    const { data: authUser, error: authError } = await supabaseAdminEngine.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { name, phone, role: 'owner' },
    });

    if (authError || !authUser?.user) {
      // Supabase returns a duplicate-email error; surface a friendly, non-leaky message.
      const msg = /already|registered|exists/i.test(authError?.message || '')
        ? 'An account with that email already exists. Try logging in instead.'
        : (authError?.message || 'Could not create the account.');
      const status = /already|registered|exists/i.test(authError?.message || '') ? 409 : 400;
      return NextResponse.json({ success: false, error: msg }, { status, headers: cors });
    }

    const ownerId = authUser.user.id;

    // Mirror into user_profiles (best-effort; ignore if a trigger already handles it).
    await supabaseAdminEngine.from('user_profiles').upsert({
      id: ownerId,
      name: name || 'Owner',
      phone: phone || '',
      role: 'owner',
    }, { onConflict: 'id' });

    // Apply the admin-configured default plan. Free/absent => no history row (implicit perpetual
    // free). A non-free default is a promotional grant, activated at zero cost.
    try {
      const { tierId } = await getDefaultSignupTier();
      if (tierId) {
        await activateSubscription({ ownerId, tierId, amountPaid: 0, ref: 'SIGNUP_DEFAULT' });
      }
    } catch (planErr) {
      // Never fail signup because the default plan couldn't be applied — the owner is free by default.
      console.error('[signup] default plan grant failed (non-fatal):', planErr);
    }

    // Sign the new owner in so the client gets a token and lands on /owner.
    const { data: session } = await supabaseClient.auth.signInWithPassword({ email, password });
    return NextResponse.json({
      success: true,
      token: session?.session?.access_token || null,
      role: 'owner',
      id: ownerId,
      name,
    }, { status: 201, headers: cors });
  } catch (err: any) {
    console.error('Signup error:', err);
    return NextResponse.json({ success: false, error: 'Sign up failed. Please try again.' }, { status: 500, headers: cors });
  }
}
