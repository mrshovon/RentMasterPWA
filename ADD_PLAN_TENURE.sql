-- Custom plan tenure (e.g. a 7-day plan) + the columns the tiers API already writes.
-- Run once in the Supabase SQL editor (service role). Idempotent — safe to re-run.
--
-- Why this exists:
--   1. Plans could only be monthly or yearly. Admins need arbitrary tenures ("7 days").
--   2. `is_active` and `discount_percent` have been written by /api/super-admin/tiers since
--      discounts shipped, but NO migration file ever added them — a latent runtime failure
--      on any database where they were not added by hand. Re-stated here idempotently, per
--      the "prefer a self-contained script" rule in MIGRATIONS.md.
--   3. Lets a perpetual plan store a null expiry (see §4) and repairs the rows already
--      written with the year-2126 sentinel (see §5).

-- 1. Tenure + the columns the API assumes ---------------------------------------------
alter table public.subscription_tiers
  add column if not exists duration_days    integer,                       -- null => derive from billing_interval
  add column if not exists is_active        boolean not null default true,
  add column if not exists discount_percent numeric not null default 0;

comment on column public.subscription_tiers.duration_days is
  'Custom tenure in days. Set when billing_interval = ''days''. Null means derive the expiry from billing_interval (month/year).';

-- A tenure must be a positive number of days when it is set at all.
alter table public.subscription_tiers
  drop constraint if exists subscription_tiers_duration_days_check;
alter table public.subscription_tiers
  add constraint subscription_tiers_duration_days_check
  check (duration_days is null or duration_days > 0) not valid;

-- 2. Allow the new 'days' billing_interval ---------------------------------------------
-- The table was built by hand, so any CHECK on billing_interval has an unknown, generated
-- name. Drop whatever is there and re-add ours under a known one — same technique as
-- ADD_NOTICE_TARGETS.sql. 'days' is deliberately a DIFFERENT value from 'custom': 'custom'
-- is the established "Contact us" / Whole Building convention (lib/subscription.ts excludes
-- it from the free-tier baseline lookup), and reusing it would silently break both.
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
      and rel.relname = 'subscription_tiers'
      and con.contype = 'c'
      and pg_get_constraintdef(con.oid) ilike '%billing_interval%'
  loop
    execute format('alter table public.subscription_tiers drop constraint %I', c.conname);
  end loop;
end $$;

-- NOT VALID: covers every value in use today, but a validated constraint would abort the
-- migration if some historic row carried something else.
alter table public.subscription_tiers
  add constraint subscription_tiers_billing_interval_check
  check (billing_interval in ('month', 'year', 'days', 'custom')) not valid;

-- 3. A 'days' plan must actually state its tenure ---------------------------------------
alter table public.subscription_tiers
  drop constraint if exists subscription_tiers_days_needs_duration_check;
alter table public.subscription_tiers
  add constraint subscription_tiers_days_needs_duration_check
  check (billing_interval <> 'days' or duration_days is not null) not valid;

-- 4. A perpetual plan has NO expiry, so the column must allow null -----------------------
-- subscription_history.expiry_date was created NOT NULL, which is why the repair in section 5
-- failed on the first run with:
--   23502: null value in column "expiry_date" of relation "subscription_history"
-- and — because the Supabase SQL editor runs a whole script in one transaction — took the
-- entire migration down with it.
--
-- This is not just a migration concern. computeExpiry() returns `Date | null` and every insert
-- site writes `expiry_date: expiry ? ... : null`. The null case is reached by a tier with no
-- billing period and no price, i.e. the live `whole_building` "Contact us" tier — so without
-- this, admin-assigning that plan fails at runtime with the same 23502.
--
-- Every reader already treats the column as nullable (lib/subscription.ts `expiryDate: string |
-- null`, both TS types, and both UI sites render "never expires" / "—"). The schema was the
-- only thing that disagreed. Idempotent: a no-op if the column is already nullable.
alter table public.subscription_history
  alter column expiry_date drop not null;

-- 5. Repair the year-2126 rows ----------------------------------------------------------
-- lib/payments/activate.ts tested "price <= 0 => perpetual" BEFORE the billing interval, so
-- any tier priced 0/null was written with `now() + 100 years` regardless of its real tenure —
-- a plan bought in 2026 showed an expiry of 2126.
--
-- Safe to null out: resolveOwnerSubscription() short-circuits on tierIsFree (price <= 0)
-- and returns a perpetual state BEFORE it ever reads expiry_date, so for these rows the
-- column is display-only. Null now renders as "Never expires".
--
-- Scoped to free tiers on purpose. A null expiry on a PAID tier is read as "ended now"
-- (lib/subscription.ts), which would instantly lock that owner out of writes.
update public.subscription_history sh
   set expiry_date = null
  from public.subscription_tiers st
 where st.id = sh.tier_id
   and coalesce(st.price, 0) <= 0
   and sh.expiry_date > now() + interval '50 years';

-- RLS is already enabled on subscription_tiers / subscription_history by ENABLE_RLS.sql
-- (deny-all; the backend reaches them with the service-role key). Nothing to change here.
