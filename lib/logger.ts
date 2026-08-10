import { supabaseAdminEngine } from './supabase-server';
import { clientIpFrom } from './password-reset-log';
import crypto from 'crypto';

// =====================================================================================
// 📓 APPLICATION LOG — the diagnostic trail behind every error the user sees.
//
// Same posture as lib/password-reset-log.ts, and for a stronger reason: this module runs inside
// the failure path. It swallows its own errors, is safe to `await`, and must NEVER throw — a
// logger that can take down the handler it is logging is worse than no logger at all.
//
// The contract with the user: they get a conventional message plus a `requestId`; the detail
// (stack, provider error, payload shape) lands here under that same id. See ADD_APP_LOGS.sql.
// =====================================================================================

export type LogLevel = 'error' | 'warn' | 'info';
export type LogSource = 'api' | 'client' | 'cron' | 'email' | 'push';

/** How much of a stack trace is worth keeping. Past this it is all framework frames. */
const MAX_DETAIL = 8000;
const MAX_MESSAGE = 500;

export interface LogInput {
  level?: LogLevel;
  source: LogSource;
  message: string;
  detail?: string | null;
  route?: string | null;
  method?: string | null;
  status?: number | null;
  code?: string | null;
  requestId?: string | null;
  userId?: string | null;
  userRole?: string | null;
  userEmail?: string | null;
  ip?: string | null;
  userAgent?: string | null;
  context?: Record<string, unknown> | null;
}

/**
 * A short, human-sayable correlation id. Shown to the user ("Reference: req_7f3k9q") and stored on
 * the row, so a support message quotes the exact log line.
 *
 * Deliberately not the full UUID: the whole point is that someone can read it off a screen and
 * type it into a chat without transcribing 36 characters.
 */
export function newRequestId(): string {
  return `req_${crypto.randomUUID().replace(/-/g, '').slice(0, 10)}`;
}

const truncate = (v: unknown, max: number): string | null => {
  if (v === null || v === undefined) return null;
  const s = String(v);
  return s.length > max ? `${s.slice(0, max)}\n… [truncated]` : s;
};

/** Pull the readable parts out of whatever was thrown. Errors are not the only thing people throw. */
export function describeError(err: unknown): { message: string; detail: string | null } {
  if (err instanceof Error) {
    return { message: err.message || err.name, detail: err.stack || null };
  }
  // Supabase returns { message, details, hint, code } objects rather than Errors.
  if (err && typeof err === 'object') {
    const o = err as Record<string, unknown>;
    const message = String(o.message ?? o.error ?? 'Unknown error');
    let detail: string | null = null;
    try {
      detail = JSON.stringify(o, null, 2);
    } catch {
      /* circular — the message alone will have to do */
    }
    return { message, detail };
  }
  return { message: String(err ?? 'Unknown error'), detail: null };
}

/**
 * The single writer. Best-effort: a failure here is reported to the console and otherwise ignored.
 */
export async function logEvent(input: LogInput): Promise<void> {
  try {
    const { error } = await supabaseAdminEngine.from('app_logs').insert([
      {
        id: crypto.randomUUID(), // no DB default on id — generate here, as everywhere else
        level: input.level ?? 'error',
        source: input.source,
        route: input.route ?? null,
        method: input.method ?? null,
        status: input.status ?? null,
        code: input.code ?? null,
        message: truncate(input.message, MAX_MESSAGE) ?? 'Unknown error',
        detail: truncate(input.detail, MAX_DETAIL),
        request_id: input.requestId ?? null,
        user_id: input.userId ?? null,
        user_role: input.userRole ?? null,
        user_email: input.userEmail ?? null,
        ip: input.ip ?? null,
        user_agent: truncate(input.userAgent, 400),
        context: input.context ?? {},
      },
    ]);
    if (error) {
      // Falls back to the console so the information is not simply lost — this is exactly the
      // state the app was in before this table existed.
      console.error('[logger] insert failed (non-fatal):', error.message, '| original:', input.message);
    }
  } catch (err) {
    console.error('[logger] crash (non-fatal):', err, '| original:', input.message);
  }
}

/**
 * Everything a request knows about who is calling, read from the headers middleware.ts injected
 * after verifying the token. Never from the body — those headers are stripped and re-set by
 * middleware precisely so they can be trusted here.
 */
export function actorFrom(request: Request): {
  userId: string | null;
  userRole: string | null;
  ip: string | null;
  userAgent: string | null;
} {
  const h = request.headers;
  return {
    userId: h.get('x-rentmaster-uid') || h.get('x-rentmaster-tenant-id') || null,
    userRole: h.get('x-rentmaster-role') || null,
    ip: clientIpFrom(h),
    userAgent: h.get('user-agent'),
  };
}

/** Route + method, for a log row that says WHERE it happened. */
export function routeFrom(request: Request): { route: string; method: string } {
  let route = '';
  try {
    route = new URL(request.url).pathname;
  } catch {
    route = request.url || '';
  }
  return { route, method: request.method || 'GET' };
}

/**
 * Log a failed API request. Returns the requestId so the caller can hand it to the user.
 */
export async function logApiError(args: {
  request: Request;
  err: unknown;
  status: number;
  code?: string | null;
  requestId?: string;
  source?: LogSource;
  context?: Record<string, unknown>;
}): Promise<string> {
  const requestId = args.requestId || newRequestId();
  const { message, detail } = describeError(args.err);
  const { route, method } = routeFrom(args.request);

  // Still print it: Vercel's runtime logs are the fastest thing to reach when the database itself
  // is what broke, and this preserves the existing `[tag] message` console convention.
  console.error(`[${requestId}] ${method} ${route} → ${args.status}:`, message);

  await logEvent({
    level: 'error',
    source: args.source ?? 'api',
    message,
    detail,
    route,
    method,
    status: args.status,
    code: args.code ?? null,
    requestId,
    context: args.context ?? null,
    ...actorFrom(args.request),
  });

  return requestId;
}
