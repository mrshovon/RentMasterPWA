-- Password reset history: an append-only audit trail of every owner password change.
-- Run once in the Supabase SQL editor (service role). Idempotent.
--
-- Three things write here (see lib/password-reset-log.ts):
--   admin_reset         -- a super admin reset an owner's password from the admin console
--   self_service_email  -- an owner completed the "forgot password" email recovery flow
--   self_change         -- a logged-in owner changed their own password in Settings
-- Only the admin can read it (exposed via /api/super-admin/password-resets).
--
-- owner_id is intentionally NOT a foreign key: owners live in auth.users, and their
-- user_profiles stub can be missing (properties.owner_id FKs have broken inserts with 23503
-- before). An audit row must never be un-writable because of a missing profile.

create table if not exists public.password_reset_history (
  id            uuid primary key,
  reset_no      bigint generated always as identity,   -- human-facing reference, e.g. "#42"
  owner_id      uuid not null,                          -- auth.users.id of the affected owner
  owner_email   text,                                   -- snapshot of the email at reset time
  reset_by      uuid,                                   -- acting admin's auth.users.id; null for self-service
  reset_method  text not null
                  check (reset_method in ('admin_reset', 'self_service_email', 'self_change')),
  ip            text,                                   -- best-effort client IP of the actor
  created_at    timestamptz not null default now()
);

create index if not exists password_reset_history_owner_idx   on public.password_reset_history (owner_id);
create index if not exists password_reset_history_created_idx on public.password_reset_history (created_at desc);

-- Same posture as ENABLE_RLS.sql: RLS on with NO policies (deny-all to anon/authenticated) and the
-- default API grants revoked. The backend reaches this table with the service-role key, which
-- bypasses RLS entirely.
alter table public.password_reset_history enable row level security;
revoke all on public.password_reset_history from anon, authenticated;
