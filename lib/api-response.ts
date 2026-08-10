import { NextResponse } from 'next/server';
import { logApiError, newRequestId, type LogSource } from './logger';

// =====================================================================================
// 🧾 API ERROR RESPONSES — one shape, one logging path.
//
// Before this file, every route hand-rolled its own catch:
//
//     catch (err: any) {
//       console.error('Xxx GET error:', err);
//       return NextResponse.json({ success: false, error: err.message }, { status: 500 });
//     }
//
// Two problems with that, and this module fixes both:
//
//   1. `err.message` went straight to the browser. A Postgres error names tables, columns and
//      constraints; a Supabase error carries hints. That is free reconnaissance, and it is also
//      unreadable to the person it reaches ("null value in column \"tier_id\" violates …").
//   2. The detail existed only in a Vercel runtime log nobody could search, so a user report of
//      "it just says it failed" was unanswerable.
//
// Now: the caller gets a conventional sentence plus a `requestId`, and the full stack lands in
// app_logs under that id, readable from the admin Logs tab. Say the reference, find the row.
//
// 4xx is different and deliberately left alone. Those messages ("Current password is incorrect.",
// "You've reached your Premium limit of 5 properties.") were written FOR the user and are the
// whole point of the response — generalising them would be a downgrade. They are recorded at
// 'warn' only when the caller opts in.
// =====================================================================================

/** What a 500 says out loud. The detail is in app_logs under the requestId. */
const GENERIC_500 = 'Something went wrong on our side. Please try again — if it keeps happening, quote this reference to support.';

export interface ApiErrorBody {
  success: false;
  error: string;
  code?: string;
  requestId?: string;
}

interface ApiErrorOptions {
  /** HTTP status. Defaults to 500. */
  status?: number;
  /** Machine-readable code the client can branch on (SUBSCRIPTION_LOCKED, …). */
  code?: string;
  /** Overrides the generic 5xx sentence when a route can say something genuinely more useful. */
  publicMessage?: string;
  /** Which subsystem failed — 'api' unless a push/email/cron helper is reporting. */
  source?: LogSource;
  /** Extra breadcrumbs stored on the log row (ids, counts — never secrets or raw payloads). */
  context?: Record<string, unknown>;
}

/**
 * Log a thrown error and return the response for it.
 *
 * `await apiError(request, err)` in a catch block replaces the console.error + NextResponse pair.
 * Awaiting matters: on Vercel a serverless function can be frozen the instant it responds, so a
 * floating insert may simply never run.
 */
export async function apiError(
  request: Request,
  err: unknown,
  options: ApiErrorOptions = {},
): Promise<NextResponse<ApiErrorBody>> {
  const status = options.status ?? 500;

  const requestId = await logApiError({
    request,
    err,
    status,
    code: options.code,
    source: options.source,
    context: options.context,
  });

  // Below 500 the message was written for a human and is safe to pass through; at 500 it was
  // written by Postgres and is not.
  //
  // The reference is appended to the MESSAGE, not left only in the `requestId` field, and that is
  // deliberate: the ~116 places the UI reports an error all do `toast.error(e.message)`. Putting
  // the id in the sentence means every one of them shows it without a single call site changing —
  // and a generic apology the user cannot quote back is not much better than no message at all.
  // `requestId` stays in the body for anything that wants to handle it properly.
  const base = options.publicMessage ?? (status < 500 ? describeForUser(err) : GENERIC_500);
  const error = status >= 500 ? `${base} (ref: ${requestId})` : base;

  const body: ApiErrorBody = { success: false, error, requestId };
  if (options.code) body.code = options.code;

  return NextResponse.json(body, { status });
}

/**
 * A refusal we expect and understand — a validation failure, a limit, a missing field. No stack,
 * nothing broken, so nothing is logged unless `log: true` asks for it (useful for the security-
 * adjacent ones: repeated 403s are worth a trail).
 */
export async function apiFail(
  request: Request,
  message: string,
  options: { status?: number; code?: string; log?: boolean; context?: Record<string, unknown> } = {},
): Promise<NextResponse<ApiErrorBody>> {
  const status = options.status ?? 400;
  const body: ApiErrorBody = { success: false, error: message };
  if (options.code) body.code = options.code;

  if (options.log) {
    const requestId = newRequestId();
    body.requestId = requestId;
    await logApiError({
      request,
      err: new Error(message),
      status,
      code: options.code,
      context: options.context,
      requestId,
    });
  }

  return NextResponse.json(body, { status });
}

/** Best-effort readable text from a sub-500 throw, without leaking a stack. */
function describeForUser(err: unknown): string {
  if (err instanceof Error && err.message) return err.message;
  if (err && typeof err === 'object') {
    const m = (err as Record<string, unknown>).message;
    if (typeof m === 'string' && m) return m;
  }
  return 'That request could not be completed.';
}
