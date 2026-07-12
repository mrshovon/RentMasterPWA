import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { createServerClient } from '@supabase/ssr';
import { verifyTenantToken } from './lib/tenant-jwt';

// 🚀 Sliding Window Rate Limiting Global Memory Tracker (Max 60 requests per minute)
const rateLimitMemoryMap = new Map<string, { totalHits: number; windowStart: number }>();

// Origins allowed to make browser (CORS) calls. Configure production origins via the
// ALLOWED_ORIGINS env var (comma-separated); localhost dev ports are the default.
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || 'http://localhost:3001,http://localhost:3000')
  .split(',').map((s) => s.trim()).filter(Boolean);

export default async function middleware(request: NextRequest) {
  const currentPath = request.nextUrl.pathname;

  // 1. CORS — reflect ONLY allow-listed origins (never arbitrary origins with credentials).
  const requestOrigin = request.headers.get('origin');
  const allowedOrigin = requestOrigin && ALLOWED_ORIGINS.includes(requestOrigin)
    ? requestOrigin
    : ALLOWED_ORIGINS[0];
  const corsHeaders = {
    'Access-Control-Allow-Origin': allowedOrigin,
    'Vary': 'Origin',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-rentmaster-uid, x-rentmaster-role, x-rentmaster-phone, x-rentmaster-tenant-id',
    'Access-Control-Allow-Credentials': 'true',
  };

  // Immediate exit for browser preflight options checks
  if (request.method === 'OPTIONS') {
    return NextResponse.json({}, { headers: corsHeaders });
  }

  // Static files and system assets skip routing validation
  if (
    currentPath.startsWith('/_next') || 
    currentPath.startsWith('/static') || 
    currentPath.endsWith('.png') || 
    currentPath.endsWith('.json')
  ) {
    return NextResponse.next();
  }

  // =========================================================================
  // 🛡️ SECURITY MITIGATION LAYER: GLOBAL RATE LIMITER & PAYLOAD WATCHDOG
  // =========================================================================
  if (currentPath.startsWith('/api/')) {
    
    // A. Payload Size Boundary Check (Rejects overflows to prevent memory bloat).
    // The multipart upload endpoint gets a larger ceiling for image attachments.
    const contentLengthBytes = parseInt(request.headers.get('content-length') || '0', 10);
    const isUploadRoute = currentPath.startsWith('/api/admin/uploads');
    const MAX_ALLOWED_PAYLOAD_LIMIT = (isUploadRoute ? 8 : 2) * 1024 * 1024; // 8MB uploads / 2MB default
    if (contentLengthBytes > MAX_ALLOWED_PAYLOAD_LIMIT) {
      return NextResponse.json(
        { error: 'Payload Limit Exceeded. Max 2MB allowed.' },
        { status: 413, headers: corsHeaders }
      );
    }
    
    // B. Memory Throttling Strategy (Max 60 requests/min per Client IP)
    // On Vercel, `x-real-ip` is set by the edge to the true client IP and CANNOT be
    // overridden by the caller, so it is the anti-spoof source of truth. We fall back to
    // the FIRST hop of `x-forwarded-for` (never the whole comma-separated chain — using the
    // full chain as the key would let an attacker rotate the leftmost value to dodge the
    // limit). NOTE: this Map is per-instance; on serverless it is a best-effort per-lambda
    // throttle only. A shared store (e.g. Upstash) is required for globally accurate limits.
    const forwardedFor = request.headers.get('x-forwarded-for');
    const clientIpAddress =
      request.headers.get('x-real-ip') ||
      (forwardedFor ? forwardedFor.split(',')[0].trim() : '') ||
      'global-anonymous-node';
    const currentEpochTime = Date.now();
    const TIME_FRAME_WINDOW_MS = 60 * 1000; // 1 Minute
    const MAX_ALLOWABLE_REQUEST_HITS = 60; // Throttling threshold

    // Memory-DoS guard: bound the map by pruning expired windows when it grows large
    // (an attacker spoofing X-Forwarded-For could otherwise create unbounded entries).
    if (rateLimitMemoryMap.size > 10000) {
      for (const [ip, log] of rateLimitMemoryMap) {
        if (currentEpochTime - log.windowStart > TIME_FRAME_WINDOW_MS) rateLimitMemoryMap.delete(ip);
      }
    }

    const clientUsageLog = rateLimitMemoryMap.get(clientIpAddress);

    if (!clientUsageLog) {
      rateLimitMemoryMap.set(clientIpAddress, { totalHits: 1, windowStart: currentEpochTime });
    } else {
      if (currentEpochTime - clientUsageLog.windowStart > TIME_FRAME_WINDOW_MS) {
        // Window expired, reset stats safely
        rateLimitMemoryMap.set(clientIpAddress, { totalHits: 1, windowStart: currentEpochTime });
      } else {
        clientUsageLog.totalHits += 1;
        if (clientUsageLog.totalHits > MAX_ALLOWABLE_REQUEST_HITS) {
          console.warn(`[SECURITY BREACH WARNING] Rate Limit hit exceeded by IP: ${clientIpAddress}`);
          return NextResponse.json(
            { error: 'Too many requests. Rate limit threshold breached. Try again in a minute.' },
            { status: 429, headers: corsHeaders }
          );
        }
      }
    }
  }

  // 2. Main Administration Routing Gatekeeper Guard
  if (
    currentPath.startsWith('/api/admin/') ||
    currentPath.startsWith('/api/super-admin/') ||
    currentPath.startsWith('/api/notifications/')
  ) {
    // Super-admin routes are admin-only (owners/tenants must be rejected).
    const isSuperAdminPath = currentPath.startsWith('/api/super-admin/');

    // Rollout switch: when a valid Bearer token is present we always use the real
    // verified identity; BYPASS_FOR_TESTING only applies as a fallback for the demo
    // one-click launches / header-based flows when no token is supplied.
    const BYPASS_FOR_TESTING = false;
    const TEST_OWNER_UUID = '0fc9f350-95ca-4a38-8d2b-56eb5c761bb8';

    const withCors = (resp: NextResponse) => {
      Object.entries(corsHeaders).forEach(([k, v]) => resp.headers.set(k, v));
      return resp;
    };
    // Inject a verified identity while stripping any client-supplied identity headers (anti-spoof).
    const injectIdentity = (fields: Record<string, string>) => {
      const h = new Headers(request.headers);
      ['x-rentmaster-uid', 'x-rentmaster-role', 'x-rentmaster-phone', 'x-rentmaster-tenant-id'].forEach((k) => h.delete(k));
      for (const [k, v] of Object.entries(fields)) if (v) h.set(k, v);
      return withCors(NextResponse.next({ request: { headers: h } }));
    };

    const authz = request.headers.get('Authorization');
    const bearer = authz && authz.startsWith('Bearer ') ? authz.slice(7) : null;

    const forbidden = () =>
      withCors(NextResponse.json({ error: 'Forbidden. Administrator access is required.' }, { status: 403 }));

    if (bearer) {
      // (a) Tenant token (backend-signed JWT).
      const tenant = await verifyTenantToken(bearer);
      if (tenant) {
        if (isSuperAdminPath) return forbidden(); // tenants can never reach super-admin
        return injectIdentity({ 'x-rentmaster-tenant-id': tenant.tenantId, 'x-rentmaster-role': 'tenant' });
      }

      // (b) Owner / Admin token (Supabase JWT).
      try {
        const supa = createServerClient(
          process.env.NEXT_PUBLIC_SUPABASE_URL!,
          process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
          { cookies: { getAll: () => [], setAll: () => {} } }
        );
        const { data } = await supa.auth.getUser(bearer);
        const u = data?.user;
        if (u) {
          const role = (u.user_metadata as any)?.role || 'owner';
          // Enforce admin-only access to super-admin endpoints (privilege-escalation fix).
          if (isSuperAdminPath && role !== 'admin') return forbidden();
          return injectIdentity({
            'x-rentmaster-uid': u.id,
            'x-rentmaster-role': role,
            'x-rentmaster-phone': u.phone || (u.user_metadata as any)?.phone || '',
          });
        }
      } catch (e) {
        console.error('Token validation error:', e);
      }
      // An invalid/expired token falls through to the bypass fallback below (or 401).
    }

    // Fallback: demo bypass — keeps the one-click demo launches and header-based tenant
    // flows working until real login is fully rolled out.
    if (BYPASS_FOR_TESTING) {
      const h = new Headers(request.headers);
      h.set('x-rentmaster-uid', TEST_OWNER_UUID);
      h.set('x-rentmaster-role', 'owner');
      h.set('x-rentmaster-phone', '01700000000');
      return withCors(NextResponse.next({ request: { headers: h } }));
    }

    return NextResponse.json(
      { error: 'Unauthorized. A valid session token is required.' },
      { status: 401, headers: corsHeaders }
    );
  }

  return NextResponse.next();
}

export const config = {
  // Global API pattern intercept to enforce rate limiter limits flawlessly
  matcher: ['/api/:path*'], 
};