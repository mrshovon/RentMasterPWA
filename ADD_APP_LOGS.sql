-- Application log: the diagnostic trail behind every error the user sees.
-- Run once in the Supabase SQL editor (service role). Idempotent.
--
-- Why it exists: the UI shows a deliberately conventional message ("Something went wrong —
-- reference req_7f3k9q") because a raw `err.message` echoed to the browser leaks schema, table
-- names and provider internals. The detail has to go SOMEWHERE, though, or a support request
-- becomes guesswork. It goes here, keyed by the same `request_id` printed in the UI, and only the
-- super admin can read it (via /api/super-admin/logs).
--
-- Written by (see lib/logger.ts):
--   api     -- a route handler threw or returned a 4xx/5xx (lib/api-response.ts apiError)
--   client  -- the browser reported a crash or a failed fetch (POST /api/logs)
--   cron    -- a scheduled job failed
--   email   -- Brevo rejected or failed to accept a send
--   push    -- web-push / FCM dispatch failed
--
-- user_id is TEXT and intentionally NOT a foreign key, for the same two reasons as
-- password_reset_history: owners live in auth.users with a possibly-missing user_profiles stub,
-- AND a tenant id is a tenants.id instead — the same column holds both, exactly like
-- device_tokens.user_id. A log row must never be un-writable; losing the diagnostic for a failure
-- because of a constraint is the one failure mode this table cannot have.

create table if not exists public.app_logs (
  id           uuid primary key,
  log_no       bigint generated always as identity,  -- human-facing reference, e.g. "#1042"
  level        text not null default 'error'
                 check (level in ('error', 'warn', 'info')),
  source       text not null default 'api'
                 check (source in ('api', 'client', 'cron', 'email', 'push')),

  route        text,        -- '/api/admin/properties'  (or a frontend path for client rows)
  method       text,        -- 'POST'
  status       integer,     -- HTTP status returned to the caller
  code         text,        -- machine code, e.g. 'SUBSCRIPTION_LOCKED'

  message      text not null,   -- one line, safe to skim
  detail       text,            -- stack trace / raw provider error; can be long
  request_id   text,            -- the reference shown to the user — the join key for support

  user_id      text,        -- auth uid (owner/admin) OR tenants.id; see note above
  user_role    text,        -- 'owner' | 'tenant' | 'admin' | null
  user_email   text,        -- snapshot, so reads never need auth.admin.listUsers()
  ip           text,
  user_agent   text,

  context      jsonb not null default '{}'::jsonb,  -- anything else worth keeping
  created_at   timestamptz not null default now()
);

-- created_at desc is the default ordering AND the keyset-pagination cursor, so it carries the
-- admin Logs tab on its own. The rest back the filter dropdowns.
create index if not exists app_logs_created_idx    on public.app_logs (created_at desc);
create index if not exists app_logs_level_idx      on public.app_logs (level);
create index if not exists app_logs_source_idx     on public.app_logs (source);
create index if not exists app_logs_user_idx       on public.app_logs (user_id);
create index if not exists app_logs_request_idx    on public.app_logs (request_id);

-- Same posture as ENABLE_RLS.sql: RLS on with NO policies (deny-all to anon/authenticated) and the
-- default API grants revoked. The backend reaches this table with the service-role key, which
-- bypasses RLS entirely.
--
-- This matters more here than anywhere else in the schema: stack traces and request context are
-- exactly what an attacker wants, and POST /api/logs is a PUBLIC route. Deny-all is what stops the
-- anon key reading back what the browser just wrote.
alter table public.app_logs enable row level security;
revoke all on public.app_logs from anon, authenticated;
