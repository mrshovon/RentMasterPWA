-- Rent reminders: owner-scheduled reminders sent to one or more tenants on a date, once or monthly.
-- Run once in the Supabase SQL editor (service role). Idempotent.
--
-- The owner picks tenants (or "all"), writes a custom message (with {tenant}/{amount}/{property}/
-- {month}/{due_date} placeholders), and a date. Delivery (backend cron + immediate for same-day)
-- pushes to each tenant and drops a row in `notices` so it shows in the tenant's inbox. A 'monthly'
-- reminder re-arms itself (scheduled_date advances a month) after each send until canceled.
--
-- owner_id is intentionally NOT a foreign key (same rationale as contact_messages / support_tickets:
-- a missing user_profiles stub must never make a reminder un-writable).

create table if not exists public.reminders (
  id             uuid primary key,
  reminder_no    bigint generated always as identity,   -- human-facing reference, e.g. "#7"
  owner_id       uuid not null,                          -- auth.users.id of the owner
  target_all     boolean not null default false,         -- true => all of the owner's tenants at send time
  tenant_ids     uuid[] not null default '{}',           -- explicit recipients when target_all is false
  message        text not null,                          -- custom message, may contain placeholders
  scheduled_date date not null,                          -- the date it fires (server/UTC date)
  recurrence     text not null default 'once'
                   check (recurrence in ('once', 'monthly')),
  status         text not null default 'pending'
                   check (status in ('pending', 'sent', 'canceled')),
  last_sent_at   timestamptz,                            -- last time it actually delivered
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create index if not exists reminders_owner_idx on public.reminders (owner_id);
-- The cron scans due, still-pending reminders by (status, scheduled_date).
create index if not exists reminders_due_idx on public.reminders (status, scheduled_date);

-- Same posture as ENABLE_RLS.sql: RLS on with NO policies (deny-all to anon/authenticated) and the
-- default API grants revoked. The backend reaches this table with the service-role key, which
-- bypasses RLS entirely.
alter table public.reminders enable row level security;
revoke all on public.reminders from anon, authenticated;
