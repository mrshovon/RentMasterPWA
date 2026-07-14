-- =============================================================================
-- RentMaster — Fix Web Push delivery + enable tenant property reassignment.
-- Run once in the Supabase SQL editor (service role). Safe to re-run.
--
-- WHY (push): `device_tokens.user_id` was a uuid with a FK -> user_profiles.id.
-- Owners live in user_profiles, but TENANTS are rows in `tenants` and are not auth
-- users, so every tenant push registration failed the FK check and 500'd (the client
-- swallowed the error). One column has to hold both an owner uid and a tenants.id,
-- so it can be a FK to neither.
--
-- WHY (tenant move): a tenant's property was creation-only. Making property_id
-- nullable allows an "unassigned" tenant (moved out / between flats). But tenant
-- ownership was derived SOLELY from properties.owner_id via a join — so an unassigned
-- tenant would become invisible to its owner and editable by any other owner. Hence
-- tenants gets its own owner_id, backfilled from the property it currently sits on.
-- =============================================================================

-- 0. device_tokens: drop every RLS policy on the table ------------------------------
-- Postgres refuses to retype a column that a policy depends on (0A000), and the original
-- dashboard-built schema left a "manage their own device tokens" policy referencing
-- user_id — which is what made step 1 below abort, rolling back this whole script.
--
-- The policies are dropped and NOT recreated, deliberately. Per ENABLE_RLS.sql this DB runs
-- RLS-on / zero-policies / grants revoked, with all real access via the service-role key
-- (which bypasses RLS). Such a policy is dead weight here — and could not work anyway once
-- user_id holds tenant ids, since tenants are not auth users and never match auth.uid().
do $$
declare
  pol record;
begin
  for pol in
    select policyname from pg_policies
     where schemaname = 'public' and tablename = 'device_tokens'
  loop
    execute format('drop policy %I on public.device_tokens', pol.policyname);
  end loop;
end $$;

-- 1. device_tokens.user_id: drop the FK to user_profiles and widen uuid -> text ------
do $$
declare
  con record;
begin
  for con in
    select conname
    from pg_constraint
    where conrelid = 'public.device_tokens'::regclass
      and contype  = 'f'
      and conkey   = array[
        (select attnum from pg_attribute
          where attrelid = 'public.device_tokens'::regclass and attname = 'user_id')
      ]
  loop
    execute format('alter table public.device_tokens drop constraint %I', con.conname);
  end loop;
end $$;

alter table public.device_tokens
  alter column user_id type text using user_id::text;

-- 2. tenants.owner_id: the tenant's own owner, independent of any property -----------
alter table public.tenants
  add column if not exists owner_id uuid references public.user_profiles (id);

-- Backfill from the property each tenant currently occupies.
update public.tenants t
   set owner_id = p.owner_id
  from public.properties p
 where t.property_id = p.id
   and t.owner_id is null;

-- Every tenant must have an owner. If this fails, some tenant has no property to
-- inherit an owner from — set its owner_id manually, then re-run.
alter table public.tenants
  alter column owner_id set not null;

create index if not exists tenants_owner_id_idx on public.tenants (owner_id);

-- 3. tenants.property_id: nullable, so a tenant can be left unassigned ---------------
alter table public.tenants
  alter column property_id drop not null;
