-- Support tickets: the upward channel from owners to the system admins.
-- Run once in the Supabase SQL editor (service role). Idempotent.
--
-- Owners file a ticket; a super admin walks it through submitted -> assigned -> in_progress -> done
-- and leaves a resolution note. `assigned_to` records which admin took it and `finished_at` when it
-- was completed, so resolution time / SLA can be reported on later.
--
-- owner_id is intentionally NOT a foreign key: properties.owner_id FKs user_profiles(id) and has
-- already broken inserts (23503) when an owner's profile stub went missing. A support ticket is what
-- an owner files when something is broken — it must not itself be breakable that way.

create table if not exists public.support_tickets (
  id                  uuid primary key,
  ticket_no           bigint generated always as identity,   -- human-facing reference, e.g. "#42"
  owner_id            uuid not null,                         -- auth.users.id of the filing owner
  subject             text not null,
  description         text not null,
  category            text not null default 'other'
                        check (category in ('billing', 'technical', 'account', 'feature_request', 'other')),
  priority            text not null default 'medium'
                        check (priority in ('low', 'medium', 'high', 'urgent')),
  status              text not null default 'submitted'
                        check (status in ('submitted', 'assigned', 'in_progress', 'done')),
  attachment_file_url text,          -- one plain URL, or several JSON-encoded (as maintenance_logs does)
  admin_remarks       text,          -- the admin's resolution note; visible to the owner
  assigned_to         uuid,          -- auth.users.id of the admin who took it
  assigned_at         timestamptz,
  finished_at         timestamptz,   -- stamped when status becomes 'done', cleared if re-opened
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create index if not exists support_tickets_owner_idx   on public.support_tickets (owner_id);
create index if not exists support_tickets_status_idx  on public.support_tickets (status);
create index if not exists support_tickets_created_idx on public.support_tickets (created_at desc);

-- Same posture as ENABLE_RLS.sql: RLS on with NO policies (deny-all to anon/authenticated) and the
-- default API grants revoked. The backend reaches this table with the service-role key, which
-- bypasses RLS entirely.
alter table public.support_tickets enable row level security;
revoke all on public.support_tickets from anon, authenticated;
