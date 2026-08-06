-- Hidden plans: a tier that is fully usable but not listed to owners.
-- Run once in the Supabase SQL editor (service role). Idempotent — safe to re-run.
--
-- Why a second flag instead of reusing is_active: `is_active = false` withdraws a plan from
-- EVERYONE, including the admin's own "Assign plan" dropdown, so it cannot express "usable, but
-- only I can hand it out". That is what bespoke pricing, a negotiated rate or a quiet promotion
-- needs.
--
--   is_active = false  -> retired. Nobody can get it, not even by assignment.
--   is_public = false  -> hidden. Invisible to owners and not self-selectable, but the admin can
--                         still assign it, and the owner already ON it keeps seeing it as their
--                         current plan so they can renew rather than silently lapsing at expiry.
--
-- Default true, so every existing plan stays listed and nothing changes the day this runs.

alter table public.subscription_tiers
  add column if not exists is_public boolean not null default true;

comment on column public.subscription_tiers.is_public is
  'False = hidden: not listed to owners and not self-selectable, but still admin-assignable, and still visible to an owner already on it. Distinct from is_active, which retires a plan for everyone.';

-- RLS is already enabled on subscription_tiers by ENABLE_RLS.sql (deny-all; the backend reaches
-- it with the service-role key). Nothing to change here.
