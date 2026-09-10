// =====================================================================================
// 🌐 WHERE THE APP LIVES — the base URL to put in a link we email to someone.
//
// Extracted from app/api/auth/forgot-password/route.ts, which worked this out for the recovery
// link and is now one of several places that needs it (account-created mail, plan notices, the
// subscriptions cron). Three copies of this precedence order would drift, and the failure mode is
// invisible: the email sends, the link goes nowhere, and nothing logs a problem.
//
// PUBLIC_APP_URL first, and it is the one to set in production. Resolving off ALLOWED_ORIGINS
// alone made the link depend on the ORDERING of the CORS list, and when that variable was unset
// it silently produced "http://localhost:3001/…" in every production email.
//
// The Origin fallback lets a preview deployment link to itself, but is trusted ONLY when the
// origin is on the allow-list — otherwise an attacker who could steer this would have other
// people's recovery links mailed to a host of their choosing.
// =====================================================================================

export function resolveAppBaseUrl(request?: { headers: Headers } | null): string {
  const allowed = (process.env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  const origin = request?.headers.get('origin') || null;

  const base =
    process.env.PUBLIC_APP_URL ||
    (origin && allowed.includes(origin) && origin) ||
    allowed[0] ||
    'http://localhost:3001';

  return base.replace(/\/$/, '');
}

/**
 * Where THIS API lives, as seen from the public internet — the base for a URL we hand to an
 * outside service to call back on (today: the UddoktaPay webhook).
 *
 * Deliberately different from resolveAppBaseUrl above, which resolves the FRONTEND. Getting the
 * two confused would point a payment webhook at the UI, where nothing would answer it.
 *
 * Derived from the incoming request by default rather than an env var, because that is the one
 * value guaranteed to be the address the caller actually reached us on — it works unchanged on
 * production, on a Vercel preview deployment, and through an ngrok/cloudflared tunnel during
 * local testing, none of which share a hostname. `x-forwarded-*` is read first because behind
 * Vercel's proxy request.url carries the internal origin, not the public one.
 *
 * PUBLIC_API_URL overrides it for the case where those headers cannot be trusted.
 */
export function resolveApiBaseUrl(request: { headers: Headers; url: string }): string {
  if (process.env.PUBLIC_API_URL) return process.env.PUBLIC_API_URL.replace(/\/$/, '');

  const host = request.headers.get('x-forwarded-host') || request.headers.get('host');
  if (host) {
    const proto =
      request.headers.get('x-forwarded-proto') ||
      (host.startsWith('localhost') || host.startsWith('127.0.0.1') ? 'http' : 'https');
    return `${proto}://${host}`;
  }

  return new URL(request.url).origin;
}

/**
 * Where a Supabase recovery link should land.
 *
 * ⚠️ Whatever this resolves to must ALSO be listed under Supabase → Authentication → URL
 * Configuration → Redirect URLs. Supabase silently ignores a redirectTo that is not on that list
 * and substitutes the Site URL, which looks identical from here.
 */
export function resolveResetUrl(request?: { headers: Headers } | null): string {
  return `${resolveAppBaseUrl(request)}/reset-password`;
}
