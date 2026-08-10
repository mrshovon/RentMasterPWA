import { getBrevoConfig, type BrevoConfig } from '../app-settings';
import { decryptField } from '../field-crypto';
import { logEvent, describeError } from '../logger';

// =====================================================================================
// ✉️ BREVO TRANSACTIONAL EMAIL
//
// The app sent no email at all before this. Signup used `email_confirm: true` (which suppresses
// Supabase's own confirmation mail), changing a password told nobody, and forgot-password leaned
// on Supabase's built-in sender — heavily rate-limited, unstyled, and impossible to change the
// wording of from here.
//
// Now three flows send through Brevo's HTTP API when the admin has connected an account:
// account creation, password change, and the password-reset link.
//
// NON-FATAL, ALWAYS. Every caller fires and forgets. A signup must not fail because a mail
// provider is down, and a password change must not roll back because a notification bounced —
// the account change already happened by the time we get here, so throwing would report a
// failure for something that succeeded. Failures return false and land in app_logs instead,
// which is the only reason anyone will ever find out the sender email was never verified.
// =====================================================================================

const BREVO_ENDPOINT = 'https://api.brevo.com/v3/smtp/email';
const TIMEOUT_MS = 10_000;

export interface SendEmailInput {
  to: string;
  toName?: string | null;
  subject: string;
  html: string;
  text: string;
}

/** The config plus its decrypted key, or null when email is not usable right now. */
async function resolveSender(): Promise<{ cfg: BrevoConfig; apiKey: string } | null> {
  const cfg = await getBrevoConfig();
  if (!cfg.enabled) return null;
  if (!cfg.senderEmail) return null;

  const apiKey = decryptField(cfg.apiKeyEnc);
  if (!apiKey) return null; // never configured, or NID_ENCRYPTION_KEY changed under us
  return { cfg, apiKey };
}

/**
 * Whether a send would be attempted at all. Used by the routes to decide between Brevo and the
 * Supabase fallback — never to gate a user-facing error, since email is always best-effort.
 */
export async function isBrevoReady(): Promise<boolean> {
  return (await resolveSender()) !== null;
}

/**
 * Send one transactional email. Returns true only when Brevo accepted it.
 *
 * "Accepted" is as far as this can ever go: delivery happens later and asynchronously, so a true
 * here means the message was queued, not that it arrived.
 */
export async function sendEmail(input: SendEmailInput): Promise<boolean> {
  const resolved = await resolveSender();
  if (!resolved) return false; // not configured / disabled — silence is the correct behaviour

  const { cfg, apiKey } = resolved;

  // Without this a provider outage would hold a signup request open until the platform's own
  // timeout killed it, turning a best-effort notification into a broken sign-up.
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(BREVO_ENDPOINT, {
      method: 'POST',
      headers: {
        'api-key': apiKey,
        'Content-Type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify({
        sender: { email: cfg.senderEmail, name: cfg.senderName || 'Bari360' },
        ...(cfg.replyTo ? { replyTo: { email: cfg.replyTo } } : {}),
        to: [{ email: input.to, ...(input.toName ? { name: input.toName } : {}) }],
        subject: input.subject,
        htmlContent: input.html,
        textContent: input.text,
      }),
      signal: abort.signal,
    });

    if (!res.ok) {
      // Brevo answers with a JSON { code, message } that names the real problem — an unverified
      // sender, a revoked key, a daily cap. Worth keeping verbatim; it is the whole diagnosis.
      const detail = await res.text().catch(() => '');
      await logEvent({
        source: 'email',
        message: `Brevo rejected the message (${res.status}): ${input.subject}`,
        detail,
        status: res.status,
        // The recipient is context, not a secret — but the key never goes anywhere near a log.
        context: { to: input.to, subject: input.subject, sender: cfg.senderEmail },
      });
      return false;
    }

    return true;
  } catch (err) {
    await logEvent({
      source: 'email',
      message: `Brevo send failed: ${input.subject}`,
      detail: describeError(err).detail,
      context: { to: input.to, subject: input.subject, aborted: abort.signal.aborted },
    });
    return false;
  } finally {
    clearTimeout(timer);
  }
}
