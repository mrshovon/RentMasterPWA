import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { logEvent, newRequestId } from '@/lib/logger';
import { clientIpFrom } from '@/lib/password-reset-log';
import { verifyTenantToken } from '@/lib/tenant-jwt';

// =====================================================================================
// 🐛 CLIENT CRASH INTAKE — POST only.
//
// The browser half of the log. A React render error or a failed fetch happens where no server
// code is running, so the only way it reaches app_logs is for the client to post it here.
//
// PUBLIC on purpose: middleware.ts gates /api/admin, /api/super-admin and /api/notifications, and
// the crashes most worth having are the ones on the LOGIN screen — before any session exists. That
// makes this the one route in the app where an anonymous caller can write a row, so everything
// below exists to bound what that is worth doing:
//
//   * 20 posts/min per IP (on top of middleware's global 60/min);
//   * every field truncated, `context` capped, unknown fields dropped;
//   * `source` is forced to 'client' — a caller cannot forge an 'api' row and poison the trail
//     the admin uses to diagnose real server failures;
//   * `level` is forced to error|warn — no writing 'info' noise;
//   * identity comes from the token, never from the body.
//
// It answers 202 unconditionally. A logger that argues with its caller (or that reveals whether a
// write succeeded) gives an attacker a probe, and the client cannot do anything useful with a
// failure anyway.
// =====================================================================================

export const dynamic = 'force-dynamic';

const MAX_BODY_BYTES = 8 * 1024;
const MAX_PER_WINDOW = 20;
const WINDOW_MS = 60 * 1000;

// Same in-memory shape as the login / forgot-password throttles. Per-lambda and best-effort on
// serverless, which is the accepted trade-off documented in middleware.ts.
const hits = new Map<string, { count: number; firstAt: number }>();

function throttled(key: string): boolean {
  const now = Date.now();
  if (hits.size > 10000) {
    for (const [k, v] of hits) if (now - v.firstAt > WINDOW_MS) hits.delete(k);
  }
  const rec = hits.get(key);
  if (!rec || now - rec.firstAt > WINDOW_MS) {
    hits.set(key, { count: 1, firstAt: now });
    return false;
  }
  rec.count += 1;
  return rec.count > MAX_PER_WINDOW;
}

/**
 * Who sent this, to the extent it can be known without a network round-trip.
 *
 * A tenant token is HMAC-signed by us, so `verifyTenantToken` settles it for free. A Supabase
 * access token would need a call to Supabase to verify, which is too much work for an endpoint
 * anyone can hit — so its payload is merely DECODED, and the row records that the attribution is
 * unverified. Nothing is ever granted on the strength of it; it only decides whose name appears
 * next to a stack trace.
 */
async function identify(bearer: string | null): Promise<{
  userId: string | null;
  userRole: string | null;
  userEmail: string | null;
  verified: boolean;
}> {
  const none = { userId: null, userRole: null, userEmail: null, verified: false };
  if (!bearer) return none;

  const tenant = await verifyTenantToken(bearer);
  if (tenant) {
    return { userId: tenant.tenantId, userRole: 'tenant', userEmail: null, verified: true };
  }

  try {
    const payload = JSON.parse(Buffer.from(bearer.split('.')[1], 'base64').toString('utf8'));
    return {
      userId: typeof payload?.sub === 'string' ? payload.sub : null,
      userRole: payload?.user_metadata?.role || 'owner',
      userEmail: typeof payload?.email === 'string' ? payload.email : null,
      verified: false,
    };
  } catch {
    return none; // not a JWT, or a mangled one — anonymous is a fine answer
  }
}

const str = (v: unknown, max: number): string | null => {
  if (typeof v !== 'string' || !v) return null;
  return v.length > max ? v.slice(0, max) : v;
};

export async function POST(request: NextRequest) {
  const accepted = NextResponse.json({ success: true }, { status: 202 });

  try {
    const ip = clientIpFrom(request.headers) || 'anonymous';
    if (throttled(ip)) return accepted;

    const declared = parseInt(request.headers.get('content-length') || '0', 10);
    if (declared > MAX_BODY_BYTES) return accepted;

    const raw = await request.text();
    if (raw.length > MAX_BODY_BYTES) return accepted;

    const body = JSON.parse(raw) as Record<string, unknown>;
    const message = str(body.message, 500);
    if (!message) return accepted; // nothing to record

    const authz = request.headers.get('Authorization');
    const who = await identify(authz?.startsWith('Bearer ') ? authz.slice(7) : null);

    // Only the caller's own breadcrumbs, re-serialised through a size check so a crafted payload
    // cannot smuggle megabytes past the length test above.
    let context: Record<string, unknown> = { identity: who.verified ? 'verified' : 'unverified' };
    if (body.context && typeof body.context === 'object') {
      const trimmed = JSON.stringify(body.context).slice(0, 2000);
      try {
        context = { ...context, ...JSON.parse(trimmed) };
      } catch {
        context.contextRaw = trimmed; // truncation broke the JSON — keep the text
      }
    }

    await logEvent({
      level: body.level === 'warn' ? 'warn' : 'error',
      source: 'client', // forced — see the header note
      message,
      detail: str(body.detail, 8000),
      route: str(body.route, 300),
      method: null,
      status: typeof body.status === 'number' ? body.status : null,
      code: str(body.code, 100),
      requestId: str(body.requestId, 60) || newRequestId(),
      userId: who.userId,
      userRole: who.userRole,
      userEmail: who.userEmail,
      ip,
      userAgent: request.headers.get('user-agent'),
      context,
    });
  } catch {
    /* never argue with the caller — see the header note */
  }

  return accepted;
}
