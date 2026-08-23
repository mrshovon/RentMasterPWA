import { NextResponse } from 'next/server';
import { supabaseClient, supabaseAdminEngine } from '@/lib/supabase-server';
import { getDefaultSignupTier, getTermsVersion } from '@/lib/app-settings';
import { activateSubscription } from '@/lib/payments/activate';
import { validateEmail, validatePhone } from '@/lib/validate';
import { sendEmail } from '@/lib/email/brevo';
import { accountCreated } from '@/lib/email/templates';
import { resolveAppBaseUrl } from '@/lib/public-url';
import { clientIpFrom } from '@/lib/password-reset-log';
import crypto from 'crypto';

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
    const password = String(body.password || '');

    const parsedEmail = validateEmail(body.email, { required: true });
    if (!parsedEmail.ok) {
      return NextResponse.json({ success: false, error: parsedEmail.error }, { status: 400, headers: cors });
    }
    const email = parsedEmail.value;

    // Optional, but a supplied number must be usable — this is a public route, so it is the
    // only thing standing between a typo (or a bot) and a permanent row.
    const parsedPhone = validatePhone(body.phone);
    if (!parsedPhone.ok) {
      return NextResponse.json({ success: false, error: parsedPhone.error }, { status: 400, headers: cors });
    }
    const phone = parsedPhone.value;

    if (password.length < 8) {
      return NextResponse.json({ success: false, error: 'Password must be at least 8 characters.' }, { status: 400, headers: cors });
    }
    if (!name) {
      return NextResponse.json({ success: false, error: 'Your name is required.' }, { status: 400, headers: cors });
    }

    // Terms acceptance. Enforced HERE and not only by the disabled button on the form, because a
    // client-side tick-box is not a consent record — this route is public and takes any JSON.
    if (body.acceptedTerms !== true) {
      return NextResponse.json(
        {
          success: false,
          error: 'Please accept the Terms and Conditions and the Privacy Policy to continue.',
          code: 'TERMS_NOT_ACCEPTED',
        },
        { status: 400, headers: cors },
      );
    }
    // The version the form actually displayed, echoed back. Falling back to the server's current
    // value would record consent against text this person may never have seen.
    const termsVersion = String(body.termsVersion || '').trim() || (await getTermsVersion());

    const key = email;
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

    // Record the acceptance. Deliberately NOT best-effort like the upsert above: this row is the
    // evidence that the person agreed, and silently losing it would leave an account that looks
    // consented-to and is not. Logged loudly if it fails — but the signup itself still completes,
    // because refusing an account after the auth user already exists would strand them with a
    // half-made account they cannot retry (the email is now taken).
    try {
      const { error: consentError } = await supabaseAdminEngine.from('terms_acceptances').insert([{
        id: crypto.randomUUID(), // no DB default on id — generate it here
        owner_id: ownerId,
        document: 'terms',
        version: termsVersion,
        ip: clientIpFrom(request.headers),
        user_agent: (request.headers.get('user-agent') || '').slice(0, 400),
        accepted_at: new Date().toISOString(),
      }]);
      if (consentError) throw consentError;
    } catch (consentErr: any) {
      console.error(
        `[signup] TERMS ACCEPTANCE NOT RECORDED for ${ownerId} (v${termsVersion}):`,
        consentErr?.message || consentErr,
      );
    }

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

    // Welcome mail. Fire-and-forget: `email_confirm: true` above means Supabase sends nothing, so
    // without this a new owner gets no written record of the account at all. Not awaited — a slow
    // or broken mail provider must never make signing up feel broken, and lib/email/brevo.ts
    // records its own failures.
    void sendEmail({
      to: email,
      toName: name || null,
      ...accountCreated({ name, email, appUrl: resolveAppBaseUrl(request) }),
    });

    // Sign the new owner in so the client gets a token and lands on /owner.
    const { data: session } = await supabaseClient.auth.signInWithPassword({ email, password });
    return NextResponse.json({
      success: true,
      token: session?.session?.access_token || null,
      refreshToken: session?.session?.refresh_token || null,
      expiresAt: session?.session?.expires_at || null,
      role: 'owner',
      id: ownerId,
      name,
    }, { status: 201, headers: cors });
  } catch (err: any) {
    console.error('Signup error:', err);
    return NextResponse.json({ success: false, error: 'Sign up failed. Please try again.' }, { status: 500, headers: cors });
  }
}
