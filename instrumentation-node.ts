// =============================================================================
// DEV LOG HYGIENE — swallow "the client hung up mid-request", and nothing else.
//
// Symptom:
//     ⨯ uncaughtException:  Error: aborted
//         at ignore-listed frames { code: 'ECONNRESET' }
//
// Reproduced and traced: the UI (:3001) and this API (:3000) are separate origins, so a write is
// a cross-origin request. When a page hard-navigates while one is still in flight — a successful
// login calls window.location.replace() the instant it persists the session — the browser severs
// the socket. Nothing in Next is listening on it, so Node's connResetException('aborted')
// escalates to process.on('uncaughtException') and gets logged three times over.
//
// It is not a fault: the server carries on serving normally. Verified directly — the request
// immediately after one of these returned 400 in 543ms, and a health check returned 200.
// The Access-Control-Max-Age added in middleware.ts already removed the preflight half of this
// (browsers now cache it instead of re-asking before every write); what is left is the request
// itself, which no server-side change can prevent because it is the browser behaving correctly.
//
// WHY THIS REPLACES NEXT'S LISTENER INSTEAD OF ADDING ONE:
// Node runs every registered 'uncaughtException' listener, so an extra one cannot stop Next
// logging. The only way to filter is to take Next's handler off, wrap it, and put the wrapper
// back, so everything that is NOT this exact case still reaches Next's own reporting untouched.
// A blanket `process.on('uncaughtException', () => {})` would hide real crashes — this must never
// become that.
//
// Dev only: importing this module is already gated on NODE_ENV in instrumentation.ts. In
// production a swallowed ECONNRESET is a missing signal, which is worse than a noisy log.
// =============================================================================

const listeners = process.listeners("uncaughtException");
const nextHandler = listeners[listeners.length - 1];

// If Next has not installed its handler yet, or its shape changed in an upgrade, do nothing.
// A slightly noisy terminal is a fair price for not taking over the process's crash semantics
// on a guess.
if (typeof nextHandler === "function") {
  process.removeListener("uncaughtException", nextHandler);
  process.on("uncaughtException", (err: NodeJS.ErrnoException, origin) => {
    // Both conditions, deliberately. ECONNRESET alone would also swallow a genuine OUTBOUND
    // failure (Supabase, FCM, web-push); the "aborted" message is what identifies an incoming
    // request whose client walked away.
    if (err?.code === "ECONNRESET" && err.message === "aborted") return;
    (nextHandler as NodeJS.UncaughtExceptionListener)(err, origin);
  });
}

// Side-effect module: this marks it as an ES module so `await import()` can type it.
export {};
