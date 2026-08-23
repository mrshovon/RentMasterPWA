-- Record of who accepted which version of the Terms and Privacy Policy, and when.
-- Run once in the Supabase SQL editor (service role). Idempotent.
--
-- Why it exists: owners could create an account with no acceptance step at all, which the Terms
-- themselves admitted in writing. A tick-box on the signup form is only worth something if the
-- acceptance is recorded — otherwise it is decoration, and in a dispute there is nothing to show.
--
-- Why a table and not user_metadata: consent evidence must not be writable by the person it is
-- evidence about, and user_metadata is. The owner holds a Supabase access token, and GoTrue's
-- PUT /auth/v1/user lets any authenticated user set arbitrary metadata keys directly against the
-- Supabase URL with the public anon key — bypassing this app entirely. lib/features.ts makes the
-- same argument for keeping paid add-on grants out of metadata ("writable by the user themselves,
-- so a paid flag there is self-grantable"). A forgeable consent record is worse than none, because
-- it looks like proof.
--
-- Why one row per acceptance, rather than a column on user_profiles: a column can only say "they
-- agreed", not "they agreed to WHICH text". When the Terms change, re-acceptance has to be a new
-- row under the new version — the same shape as plan_events, where `ref` stops a renewed plan's
-- event being swallowed by the previous one.
--
-- ip and user_agent are snapshots taken at the moment of acceptance, matching what
-- password_reset_history already captures for the same evidential reason.
--
-- owner_id is `text` and deliberately NOT a foreign key, for the reason repeated throughout these
-- migrations: a row that records a real event must never be un-writable because a stub row is
-- missing. Here it matters more than usual — this row is inserted seconds after the auth user is
-- created, and a FK race would fail the signup it is meant to document.

create table if not exists public.terms_acceptances (
  id            uuid primary key,                    -- no DB default; the app supplies crypto.randomUUID()
  acceptance_no bigint generated always as identity, -- human-facing reference, e.g. "#42"
  owner_id      text not null,                       -- auth uid of the accepting owner
  document      text not null default 'terms'
                  check (document in ('terms', 'privacy')),
  version       text not null,                       -- the version string shown at the time, e.g. '2026-08-15'
  ip            text,                                -- best-effort, same source as password_reset_history.ip
  user_agent    text,                                -- truncated by the app, as in user_presence
  accepted_at   timestamptz not null default now(),
  created_at    timestamptz not null default now()
);

-- "What has this owner accepted, newest first" — the only query, used to decide whether a signed-in
-- owner needs to re-accept an updated version.
create index if not exists terms_acceptances_owner_idx
  on public.terms_acceptances (owner_id, accepted_at desc);

-- Same posture as ENABLE_RLS.sql: RLS on with NO policies (deny-all to anon/authenticated) and the
-- default API grants revoked. The backend reaches this table with the service-role key, which
-- bypasses RLS entirely. It matters more here than elsewhere: this table is the evidence, and the
-- person it is evidence about must not be able to reach it.
alter table public.terms_acceptances enable row level security;
revoke all on public.terms_acceptances from anon, authenticated;
