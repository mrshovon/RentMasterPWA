-- One-time plans: a tier an owner may take exactly once, e.g. a trial.
-- Run once in the Supabase SQL editor (service role). Idempotent — safe to re-run.
--
-- Every plan used to be renewable forever, which made a trial impossible: a 7-day trial could be
-- renewed indefinitely and would never convert.
--
--   is_recurring = true   -> renewable. The owner can take it again whenever they like. (default)
--   is_recurring = false  -> ONE-TIME. The owner may take it once; after that they must choose a
--                            different plan. Enforced server-side on both owner write paths, not
--                            just by hiding the button. The admin can still re-assign it as an
--                            escape hatch, the same way hidden plans work.
--
-- "Already used" simply means the owner has a subscription_history row for that tier, so no extra
-- bookkeeping table is needed.
--
-- ⚠️ Pairs with a change in lib/subscription.ts: when a one-time plan expires the owner now falls
-- back to the FREE plan instead of the paid grace-then-lock path. Without that, a trial (priced 0
-- but carrying an explicit duration_days, which tierIsFree() excludes) would run the paid
-- lifecycle and LOCK every trial user who did not convert, ten days after their trial ended.
--
-- Default true, so every existing plan stays renewable and nothing changes the day this runs.

alter table public.subscription_tiers
  add column if not exists is_recurring boolean not null default true;

comment on column public.subscription_tiers.is_recurring is
  'False = one-time: the owner may take this plan once (a trial), then must choose another. On expiry they fall back to the free plan rather than being locked. Admin can still re-assign it.';

-- RLS is already enabled on subscription_tiers by ENABLE_RLS.sql (deny-all; the backend reaches
-- it with the service-role key). Nothing to change here.
