import { supabaseAdminEngine } from './supabase-server';
import crypto from 'crypto';

// =====================================================================================
// Password reset audit log — one shared writer for all three reset paths so every row
// has an identical shape. Best-effort by design: a logging failure must NEVER break the
// reset itself (same posture as the fire-and-forget push in support-tickets). Callers can
// `await` it safely; it swallows its own errors.
// =====================================================================================

export type ResetMethod = 'admin_reset' | 'self_service_email' | 'self_change';

export interface LogPasswordResetInput {
  ownerId: string;
  ownerEmail?: string | null;
  resetBy?: string | null;   // acting admin id; omit/null for self-service
  method: ResetMethod;
  ip?: string | null;
}

export async function logPasswordReset(input: LogPasswordResetInput): Promise<void> {
  try {
    const { error } = await supabaseAdminEngine.from('password_reset_history').insert([
      {
        id: crypto.randomUUID(),                 // no DB default on id — generate here
        owner_id: input.ownerId,
        owner_email: input.ownerEmail ?? null,
        reset_by: input.resetBy ?? null,
        reset_method: input.method,
        ip: input.ip ?? null,
      },
    ]);
    if (error) console.error('[password-reset-log] insert failed (non-fatal):', error.message);
  } catch (err) {
    console.error('[password-reset-log] crash (non-fatal):', err);
  }
}

/**
 * Tell the owner their password changed.
 *
 * Lives next to `logPasswordReset` because it has exactly the same three call sites — the admin
 * reset, the email recovery flow, and the self-change in Settings — and the same rule: it must
 * never break the thing it is reporting. By the time this runs the password has ALREADY changed,
 * so throwing here would report a failure for an operation that succeeded.
 *
 * Kept as a separate call rather than folded into `logPasswordReset` so that "write an audit row"
 * and "email the user" stay visibly distinct at each site; a function named `log…` that silently
 * sends mail is the kind of thing nobody finds until it sends the wrong mail.
 *
 * This is the security notice that matters most in the whole app: it is how someone finds out
 * their account was taken over.
 */
export async function notifyPasswordChanged(input: {
  ownerId: string;
  ownerEmail?: string | null;
  byAdmin?: boolean;
  ip?: string | null;
}): Promise<void> {
  try {
    // Dynamic imports so this module stays usable from anywhere without dragging the mail stack
    // (and its settings lookup) into every caller that only wants the audit row.
    const [{ sendEmail }, { passwordChanged }] = await Promise.all([
      import('./email/brevo'),
      import('./email/templates'),
    ]);

    let email = input.ownerEmail ?? null;
    let name = '';
    try {
      const { data } = await supabaseAdminEngine.auth.admin.getUserById(input.ownerId);
      email = email || data?.user?.email || null;
      name = (data?.user?.user_metadata as any)?.name || '';
    } catch {
      /* fall back to whatever the caller passed */
    }
    if (!email) return;

    const at = new Date().toLocaleString('en-GB', {
      dateStyle: 'medium',
      timeStyle: 'short',
      timeZone: 'Asia/Dhaka',
    });

    await sendEmail({
      to: email,
      toName: name || null,
      ...passwordChanged({ name, at, ip: input.ip ?? null, byAdmin: !!input.byAdmin }),
    });
  } catch (err) {
    console.error('[password-reset-log] change notification failed (non-fatal):', err);
  }
}

// Best-effort client IP from the standard proxy headers (matches middleware's approach:
// x-real-ip is edge-set and un-spoofable on Vercel; fall back to the first x-forwarded-for hop).
export function clientIpFrom(headers: Headers): string | null {
  const realIp = headers.get('x-real-ip');
  if (realIp) return realIp;
  const xff = headers.get('x-forwarded-for');
  if (xff) return xff.split(',')[0].trim() || null;
  return null;
}
