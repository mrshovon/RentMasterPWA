-- Widen the notices audience so a super-admin circulation can target more than "all owners".
-- Run once in the Supabase SQL editor (service role). Idempotent — safe to re-run.
--
-- Scopes after this migration:
--   everyone           -- every owner AND every tenant on the platform (admin only)
--   all_owners         -- every owner                                  (admin only)
--   all_tenants        -- every tenant                                 (admin, or an owner's own)
--   individual_owner   -- one owner,  target_owner_id                  (admin only)   <- NEW
--   individual_tenant  -- one tenant, target_tenant_id
--
-- target_owner_id is intentionally NOT a foreign key — same rationale as staff / reminders /
-- contact_messages (see ADD_STAFF.sql): a missing or lagging user_profiles stub must never make
-- a record un-writable. The API already resolves the owner from the authenticated admin session.

-- 1. The new target column ------------------------------------------------------------
alter table public.notices
  add column if not exists target_owner_id uuid;

create index if not exists notices_target_owner_id_idx
  on public.notices (target_owner_id)
  where target_owner_id is not null;

-- Scope reads are always "give me everything this session may see", so the scope column is in
-- every WHERE clause of /api/admin/notices GET.
create index if not exists notices_target_scope_idx
  on public.notices (target_scope);

-- 2. Allow the new scope values -------------------------------------------------------
-- The original table may or may not carry a CHECK constraint on target_scope (and its name is
-- whatever Postgres generated). Drop ANY check constraint that mentions target_scope, then add
-- ours back under a known name. Done in a DO block so a fresh database and an existing one
-- both end up in exactly the same state.
do $$
declare
  c record;
begin
  for c in
    select con.conname
    from pg_constraint con
    join pg_class rel on rel.oid = con.conrelid
    join pg_namespace nsp on nsp.oid = rel.relnamespace
    where nsp.nspname = 'public'
      and rel.relname = 'notices'
      and con.contype = 'c'
      and pg_get_constraintdef(con.oid) ilike '%target_scope%'
  loop
    execute format('alter table public.notices drop constraint %I', c.conname);
  end loop;
end $$;

-- NOT VALID here too: the list above covers every value present today, but a validated
-- constraint would abort the migration if any historic row ever used something else.
alter table public.notices
  add constraint notices_target_scope_check
  check (target_scope in (
    'everyone', 'all_owners', 'all_tenants', 'individual_owner', 'individual_tenant'
  )) not valid;

-- 3. An individual scope must actually name its target --------------------------------
-- Added NOT VALID on purpose. Live data already contains 'individual_owner' rows written by
-- tenants BEFORE this column existed, so they have a null target_owner_id; a validated
-- constraint would refuse to apply and abort the whole migration. NOT VALID enforces the rule
-- on every INSERT/UPDATE from now on and leaves those legacy rows alone (they are unreachable
-- by the API's scope filters either way). To adopt them later, backfill target_owner_id and run
--   alter table public.notices validate constraint notices_target_present_check;
alter table public.notices
  drop constraint if exists notices_target_present_check;

alter table public.notices
  add constraint notices_target_present_check
  check (
    (target_scope <> 'individual_tenant' or target_tenant_id is not null) and
    (target_scope <> 'individual_owner'  or target_owner_id  is not null)
  ) not valid;

-- RLS is already enabled on public.notices by ENABLE_RLS.sql (deny-all; the backend reaches
-- this table with the service-role key, which bypasses RLS). Nothing to change here.
