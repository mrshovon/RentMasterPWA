import { supabaseAdminEngine } from './supabase-server';
import { validateEmail, isSystemLogin } from './validate';
import { isDuplicateEmailError } from './building';
import { actorFrom, routeFrom, logEvent, describeError } from './logger';

// =====================================================================================
// CHANGE A SIGN-IN EMAIL — one implementation for both doors into it.
//
// Two routes call this: the super-admin changing someone else's address, and the account
// holder using the one-shot opt-in. Keeping the validation, uniqueness check, write and audit
// in one place is the whole point — two copies of "just swap the email in auth.users" is how
// one of them forgets to tell the old mailbox, which is the only way the real user finds out.
//
// Two rules are absolute here:
//   1. @bari360.com system logins are refused in both directions. That string IS the login ID;
//      isSystemLogin() also silently stops mail, blocks self-service password reset and redacts
//      the address from tenant views. Flipping it would change all three with no warning.
//   2. email_confirm: true, matching every createUser() in the app — the admin (or a re-authed
//      owner) is the verification. No confirmation mail is needed to complete the change.
// =====================================================================================

export type EmailChangeActor = 'admin' | 'self';

export interface ChangeEmailInput {
  request: Request;
  ownerId: string;
  newEmail: string;
  actor: EmailChangeActor;
  /** Old address, when the caller already has it (avoids one lookup). Looked up otherwise. */
  oldEmail?: string | null;
  /** Public frontend URL, for the "open Bari360" link in the security mail. */
  appUrl: string;
}

// One shape rather than a discriminated union: this repo compiles with strict: false, where
// boolean literal properties don't narrow reliably at the call site. `ok` is the discriminator
// by convention; the error fields are only present when it is false.
export interface ChangeEmailResult {
  ok: boolean;
  status?: number;
  code?: string;
  error?: string;
  oldEmail?: string;
  email?: string;
}

const fail = (status: number, code: string, error: string): ChangeEmailResult =>
  ({ ok: false, status, code, error });

export async function changeOwnerEmail(input: ChangeEmailInput): Promise<ChangeEmailResult> {
  // validateEmail lowercases and enforces the same shape as signup/create-owner.
  const parsed = validateEmail(input.newEmail, { required: true });
  if (!parsed.ok) return fail(400, 'INVALID_EMAIL', parsed.error);
  const next = parsed.value;

  if (isSystemLogin(next)) {
    return fail(409, 'SYSTEM_LOGIN_NOT_ALLOWED',
      'That is a system login identifier, not a real mailbox. Choose a different email address.');
  }

  const { data: cur, error: getErr } = await supabaseAdminEngine.auth.admin.getUserById(input.ownerId);
  if (getErr || !cur?.user) return fail(404, 'ACCOUNT_NOT_FOUND', 'Account not found.');
  const user = cur.user;
  const oldEmail = String(input.oldEmail ?? user.email ?? '').trim().toLowerCase();

  if (isSystemLogin(oldEmail)) {
    return fail(409, 'SYSTEM_LOGIN_NOT_ALLOWED',
      'This account signs in with a system login ID, which cannot be changed here. Contact support.');
  }
  if (!oldEmail) {
    return fail(409, 'NO_CURRENT_EMAIL', 'This account has no email address on file.');
  }
  if (oldEmail === next) {
    return fail(400, 'EMAIL_UNCHANGED', 'That is already the sign-in email.');
  }

  // Let the unique constraint answer rather than pre-checking with listUsers(): that pages at
  // 1000 and is racy, exactly as in the login-id generator (lib/building.ts).
  const { data: updated, error: updErr } = await supabaseAdminEngine.auth.admin.updateUserById(
    input.ownerId,
    { email: next, email_confirm: true },
  );
  if (updErr) {
    if (isDuplicateEmailError(updErr)) {
      return fail(409, 'EMAIL_IN_USE', 'That email address is already used by another account.');
    }
    throw updErr; // unexpected provider failure -> the route's apiError logs it with a requestId
  }

  const email = updated?.user?.email || next;
  const name = String((user.user_metadata as any)?.name || '');
  const ip = actorFrom(input.request).ip;

  // Audit. A successful change is worth a log row just as much as a failed one — this is an
  // account-takeover primitive, so "who did it and when" must be answerable later.
  await logEvent({
    level: 'info',
    source: 'api',
    message: `Sign-in email changed by ${input.actor}: ${oldEmail} -> ${email}`,
    context: { ownerId: input.ownerId, actor: input.actor, from: oldEmail, to: email },
    userEmail: email,
    ...actorFrom(input.request),
    ...routeFrom(input.request),
  });

  // Both halves are fire-and-forget: the email has already changed, so a slow mail provider or
  // a missing notices table must never turn a successful change into a 500.
  void sendSecurityMail({
    name, oldEmail, email, ip, byAdmin: input.actor === 'admin', appUrl: input.appUrl,
  });
  void sendInAppNotice({ ownerId: input.ownerId, email, byAdmin: input.actor === 'admin' });

  return { ok: true, oldEmail, email };
}

async function sendSecurityMail(args: {
  name: string;
  oldEmail: string;
  email: string;
  ip: string | null;
  byAdmin: boolean;
  appUrl: string;
}): Promise<void> {
  try {
    // Dynamic, as in lib/password-reset-log.ts — a caller that only changes the address need not
    // pull the whole mail stack into its module graph.
    const [{ sendEmail }, { emailChanged }] = await Promise.all([
      import('./email/brevo'),
      import('./email/templates'),
    ]);
    const at = new Date().toLocaleString('en-GB', {
      dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Dhaka',
    });
    const body = emailChanged({
      name: args.name,
      oldEmail: args.oldEmail,
      newEmail: args.email,
      at,
      ip: args.ip,
      byAdmin: args.byAdmin,
      appUrl: args.appUrl,
    });
    // Old mailbox first on purpose: it is the one that needs the warning if this was not them.
    await sendEmail({ to: args.oldEmail, toName: args.name || null, ...body });
    await sendEmail({ to: args.email, toName: args.name || null, ...body });
  } catch (err) {
    await logEvent({
      level: 'warn',
      source: 'email',
      message: `Email-change security notice failed for ${args.email}`,
      detail: describeError(err).detail,
      context: { to: args.email },
    });
  }
}

async function sendInAppNotice(args: {
  ownerId: string;
  email: string;
  byAdmin: boolean;
}): Promise<void> {
  try {
    const { notifyOwner } = await import('./notify');
    await notifyOwner({
      userId: args.ownerId,
      title: 'Sign-in email changed',
      body: args.byAdmin
        ? `An administrator changed your sign-in email to ${args.email}. If this was not you, contact support.`
        : `Your sign-in email was changed to ${args.email}. If this was not you, contact support.`,
      url: '/owner',
      tag: 'email-changed',
    });
  } catch (err) {
    await logEvent({
      level: 'warn',
      source: 'api',
      message: `Email-change in-app notice failed for ${args.ownerId}`,
      detail: describeError(err).detail,
    });
  }
}
