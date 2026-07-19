-- Contact-us messages: enquiries an owner sends from the "Contact us" button on the custom
-- (Whole Building) plan card. Run once in the Supabase SQL editor (service role). Idempotent.
--
-- Owners submit; a super admin works the message new -> in_progress -> resolved (or archived)
-- and can leave an internal note. Mirrors support_tickets.
--
-- owner_id is intentionally NOT a foreign key (owners live in auth.users; a missing user_profiles
-- stub must never make the enquiry un-writable), same rationale as support_tickets.

create table if not exists public.contact_messages (
  id            uuid primary key,
  message_no    bigint generated always as identity,   -- human-facing reference, e.g. "#7"
  owner_id      uuid not null,                          -- auth.users.id of the enquiring owner
  name          text,
  email         text,
  phone         text,
  tier_id       text,                                   -- the plan they enquired about (subscription_tiers.id is a text slug, e.g. 'whole_building')
  message       text not null,
  status        text not null default 'new'
                  check (status in ('new', 'in_progress', 'resolved', 'archived')),
  admin_notes   text,                                   -- internal note, not shown to the owner
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index if not exists contact_messages_owner_idx   on public.contact_messages (owner_id);
create index if not exists contact_messages_status_idx  on public.contact_messages (status);
create index if not exists contact_messages_created_idx on public.contact_messages (created_at desc);

-- Same posture as ENABLE_RLS.sql: RLS on with NO policies (deny-all) and grants revoked.
-- The backend reaches this table with the service-role key, which bypasses RLS.
alter table public.contact_messages enable row level security;
revoke all on public.contact_messages from anon, authenticated;
