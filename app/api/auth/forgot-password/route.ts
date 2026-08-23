import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { supabaseClient, supabaseAdminEngine } from '@/lib/supabase-server';
import { validateEmail, isSystemLogin } from '@/lib/validate';
import { resolveResetUrl } from '@/lib/public-url';
import { isBrevoReady, sendEmail } from '@/lib/email/brevo';
import { passwordReset } from '@/lib/email/templates';

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

// How long Supabase's recovery links live, for the wording in our own email. Supabase's default
// is 1 hour; it is not readable from here, so this is stated rather than derived.
const RECOVERY_TTL_MINUTES = 60;

// Generic acknowledgement — identical whether or not the email exists.
const ack = () =>
  NextResponse.json(
    { success: true, message: 'If an account exists for that email, a reset link is on its way.' },
    { status: 200, headers: cors },
  );

/**
 * Mint the recovery link ourselves and mail it through Brevo.
 *
 * `generateLink` does NOT send anything — it returns the same one-time action link Supabase would
 * have emailed, which is what lets us wrap it in our own template. It requires the service role,
 * and it throws for an address with no account, so everything here is swallowed: the caller must
 * behave identically for a real and an unknown address.
 */
async function sendViaBrevo(email: string, redirectTo: string): Promise<void> {
  try {
    const { data, error } = await supabaseAdminEngine.auth.admin.generateLink({
      type: 'recovery',
      email,
      options: { redirectTo },
    });
    if (error || !data?.properties?.action_link) return; // no such account — indistinguishable

    const name = (data.user?.user_metadata as any)?.name || '';
    const body = passwordReset({
      name,
      actionLink: data.properties.action_link,
      expiresMinutes: RECOVERY_TTL_MINUTES,
    });

    await sendEmail({ to: email, toName: name || null, ...body });
  } catch {
    /* A mail failure is already recorded by lib/email/brevo.ts; the caller must stay generic. */
  }
}

export async function OPTIONS() {
  return NextResponse.json({}, { headers: cors });
}

export async function POST(request: NextRequest) {
  try {
    const { email } = await request.json();
    const parsed = validateEmail(email, { required: true });
    if (!parsed.ok) {
      return NextResponse.json({ success: false, error: parsed.error }, { status: 400, headers: cors });
    }

    // Building-tier accounts sign in with a system-issued identifier, not a mailbox, so there is
    // nowhere for a link to go. Answered BEFORE the throttle and before any Supabase call.
    //
    // This deliberately breaks the generic-acknowledgement rule above, and that is correct: the
    // ENTIRE domain is system-issued, so saying "these cannot self-reset" reveals nothing about
    // whether this particular identifier exists. The enumeration defence protects real addresses
    // and is untouched. Answering with the usual ack would be the worse outcome by far — it
    // promises a link that will never arrive, to someone who would then wait for it.
    if (isSystemLogin(parsed.value)) {
      return NextResponse.json(
        {
          success: true,
          code: 'SYSTEM_LOGIN',
          message:
            "Building accounts can't reset their own password. Ask your building administrator to set a new one for you.",
        },
        { status: 200, headers: cors },
      );
    }

    const key = parsed.value; // validateEmail already trims and lowercases
    if (isThrottled(key)) return ack(); // stay generic even when throttled — no signal to the caller
    record(key);

    const redirectTo = resolveResetUrl(request);
    // Logged because a wrong value here is invisible from every other vantage point: the user
    // gets a real email containing a dead link, and this endpoint returns its usual 200.
    console.log('[forgot-password] recovery link will point at', redirectTo);

    // Two senders, one behaviour.
    //
    // When the admin has connected Brevo we mint the recovery link OURSELVES with
    // generateLink() and send it through our own bilingual template — which is the only way the
    // wording, the sender name and the Bangla half are ours rather than whatever is configured in
    // the Supabase dashboard. Otherwise we fall back to Supabase's built-in mailer, exactly as
    // before, so turning Brevo off never breaks password recovery.
    //
    // Either way the result is ignored and the response is identical: generateLink() errors for
    // an address with no account, and that difference must never be observable from outside.
    if (await isBrevoReady()) {
      await sendViaBrevo(key, redirectTo);
    } else {
      await supabaseClient.auth.resetPasswordForEmail(key, { redirectTo });
    }

    return ack();
  } catch (err: any) {
    console.error('Forgot-password error:', err);
    // Even on internal error, do not leak specifics — return the same generic ack.
    return ack();
  }
}
