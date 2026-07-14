-- Let owners stop an unassigned tenant from logging in.
-- Run once in the Supabase SQL editor (service role). Idempotent.
--
-- A tenant with no property (moved out / between flats) could still sign in. The rule is now:
--
--     may log in  <=>  property_id is not null  OR  allow_login_unassigned
--
-- so unassigned tenants are blocked by DEFAULT (allow_login_unassigned = false), and the owner
-- can grant a per-tenant exception from the Tenants tab (e.g. a departing tenant who still needs
-- their rent receipts). Assigned tenants are unaffected regardless of the flag.
--
-- `tenants` already has RLS enabled with no policies (see ENABLE_RLS.sql), so a plain column add
-- needs nothing further.

alter table public.tenants
  add column if not exists allow_login_unassigned boolean not null default false;
