-- Plan lifecycle events: what the owner has already been told about their subscription.
-- Run once in the Supabase SQL editor (service role). Idempotent.
--
-- The problem this solves: subscription state is COMPUTED, not stored. lib/subscription.ts derives
-- active / grace / downgraded from `subscription_history.expiry_date` and Date.now() every time
-- anyone asks. That is the right design — it is always correct and needs no reconciliation — but
-- it means an expiry is not an *event*. Nothing happens when a plan lapses; the answer simply
-- changes the next time someone looks. So there was nowhere at all to hang a notification.
--
-- /api/cron/subscriptions supplies the missing edge: it runs daily, resolves every owner, and
-- writes a row here for each transition it finds. This table is therefore two things at once —
-- the dedupe key that stops the cron sending the same warning every morning, and the record the
-- owner dashboard reads to decide whether to show its one-time "your plan has ended" modal.
--
-- `ref` is what makes it idempotent ACROSS RENEWALS. It holds the expiry date the event belongs
-- to, so re-running the cron is a no-op, but a renewed plan (a new expiry date) is a genuinely new
-- event and gets its own row. Keying on (owner_id, event) alone would silently swallow the second
-- expiry an owner ever had. Same shape as the `welcome_dispatch` dedupe table in ADD_PRESENCE.sql.
--
-- owner_id is TEXT and deliberately not a foreign key, for the same reason as
-- password_reset_history: owners live in auth.users and their user_profiles stub can be missing,
-- and a notification record must never be un-writable.

create table if not exists public.plan_events (
  id           uuid primary key,
  owner_id     text not null,
  event        text not null
                 check (event in ('expiring_soon', 'grace_started', 'downgraded')),

  tier_id      text,          -- the plan the event is about
  tier_name    text,          -- snapshot: the tier may be renamed or retired later
  ref          text not null, -- the expiry_date this belongs to; '' when the plan had none

  notified_at  timestamptz not null default now(),  -- when the cron sent notice + push + email
  seen_at      timestamptz,                          -- when the owner acknowledged the modal
  created_at   timestamptz not null default now()
);

-- The idempotency guarantee. ON CONFLICT DO NOTHING against this constraint is how the cron
-- decides whether it has already told this owner about this particular expiry.
create unique index if not exists plan_events_unique_idx
  on public.plan_events (owner_id, event, ref);

-- The owner dashboard's query: "my newest unacknowledged event".
create index if not exists plan_events_owner_idx   on public.plan_events (owner_id, created_at desc);
create index if not exists plan_events_unseen_idx  on public.plan_events (owner_id) where seen_at is null;

-- Same posture as ENABLE_RLS.sql: RLS on with NO policies (deny-all to anon/authenticated) and the
-- default API grants revoked. The backend reaches this table with the service-role key.
alter table public.plan_events enable row level security;
revoke all on public.plan_events from anon, authenticated;
