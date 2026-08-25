-- Whole Building plan, phase 5: THE COMMERCIAL LIFECYCLE — term, payment, renewal, receipts.
-- Run once in the Supabase SQL editor (service role). Idempotent — safe to re-run.
-- Requires ADD_BUILDINGS.sql (buildings).
--
-- The problem this solves: a Whole Building contract is sold offline as a yearly deal, and the
-- app knew nothing about it. The `whole_building` tier is priced 0 with billing_interval
-- 'custom', which makes tierIsFree() true in lib/subscription.ts — so a building admin's plan was
-- PERPETUAL. It never expired, never warned, never locked, and there was nowhere to record
-- whether the building had actually paid. The only lever was the admin permissions_revoked flag.
--
-- HOW THIS PLUGS IN, and why there is no second enforcement path:
--   resolveOwnerSubscription() already substitutes the BUILDING ADMIN's resolved subscription
--   into every flat owner who has no plan of their own, status and lockReason included, and
--   PLAN_GOVERNED_ROLES already contains 'building_admin' so assertOwnerCanWrite() gates the
--   admin at ~50 route call sites. lib/building-plan.ts computes a state from
--   building_subscriptions and lib/subscription.ts OVERLAYS it onto the resolved plan. Locking,
--   warning and flat-owner propagation therefore all fall out of machinery that already exists.
--   Nothing here touches subscription_tiers or subscription_history.
--
--   *** building_plan_payments ROWS ARE THE TRUTH. ***
--   An invoice's amount_paid, payment_status and paid_at are DERIVED from them by
--   recalcPlanInvoice() in lib/building-plan.ts and written by nothing else. Same rule as
--   building_service_invoices one level down, for the same reason.
--
-- Deliberate design notes:
--   * building_subscriptions stores FACTS (dates, tenure, flags), never a computed status.
--     Status is derived at read time by buildingPlanState(), which is what makes it correct the
--     moment a date passes even if the notification cron never runs — the discipline
--     lib/subscription.ts has followed since the beginning.
--   * The terminal state for a building is LOCKED, not a drop to the free tier. An owner whose
--     plan lapses falls back to 2 properties / 2 tenants and keeps working; a whole building
--     cannot meaningfully do that. This revives lockReason 'expired', which assertOwnerCanWrite()
--     has always had the right copy for and which time could no longer reach.
--   * Per-building grace_days / warn_days / term_months columns rather than constants, because
--     "1 year by default, but the admin can choose in special cases" is the whole requirement.
--   * building_plan_events is its OWN dedupe table rather than four new values in plan_events'
--     CHECK constraint: ADD_PLAN_EVENTS.sql has not been run yet, and altering a CHECK on a live
--     table to depend on an unrun migration is how a deploy breaks two features at once.
--
-- uid columns (admin_id, recorded_by, reviewed_by) are plain uuid and never foreign keys to
-- user_profiles — see the header of ADD_BUILDINGS.sql for why that FK is actively harmful.
-- building_id DOES reference buildings(id), a table these migrations created.
--
-- No `default gen_random_uuid()` on any id: every route generates crypto.randomUUID(), matching
-- the rest of this codebase (properties.id has no default either, and that once cost a debug
-- session).

-- =====================================================================================
-- 1. THE BUILDING'S SUBSCRIPTION — one row per building, the facts of its contract.
-- =====================================================================================
create table if not exists public.building_subscriptions (
  building_id     uuid primary key references public.buildings (id) on delete cascade,
  -- Denormalised from buildings.admin_id. This is the HOT PATH key: lib/subscription.ts looks the
  -- plan up by the caller's auth uid on every resolve, which runs 2-3 times in a single write.
  -- Joining through buildings on that path would double the query count for every owner in the
  -- system, building or not.
  admin_id        uuid not null,
  term_months     integer not null default 12 check (term_months > 0 and term_months <= 120),
  -- Both null until the first payment lands: the 12-month clock starts the day money is recorded,
  -- so a building that takes twelve days to pay still gets a full year.
  term_starts_on  date,
  expiry_date     date,
  -- The unpaid window. A newly created building has full access until this date and a banner
  -- counting down to it; past it, with nothing paid, it locks.
  pay_by          date not null,
  first_paid_at   timestamptz,
  -- Post-expiry buffer before the lock, and how far ahead of expiry to start warning. Defaults
  -- differ from the owner lifecycle's 10/10 on purpose — a yearly contract needs more runway
  -- than a monthly one, and renewing a building involves a human conversation.
  grace_days      integer not null default 15 check (grace_days >= 0 and grace_days <= 180),
  warn_days       integer not null default 30 check (warn_days >= 0 and warn_days <= 180),
  -- A deliberate administrative stop, distinct from an ordinary lapse. Reads as lockReason
  -- 'revoked' rather than 'expired', so the message the admin sees is the honest one.
  canceled_at     timestamptz,
  notes           text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

-- UNIQUE, not just an index: one subscription per building admin, and it is the lookup key.
create unique index if not exists building_subscriptions_admin_idx
  on public.building_subscriptions (admin_id);

-- =====================================================================================
-- 2. PLAN INVOICES — what we are billing this building for a term.
-- =====================================================================================
create table if not exists public.building_plan_invoices (
  id             uuid primary key,
  invoice_no     bigint generated always as identity,   -- human-facing reference, e.g. "#12"
  building_id    uuid not null references public.buildings (id) on delete cascade,
  admin_id       uuid not null,                          -- the billing party (the building admin)
  kind           text not null default 'renewal'
                   check (kind in ('initial', 'renewal')),
  term_months    integer not null default 12 check (term_months > 0),
  -- What the bill covers. Null until known — an initial invoice is raised before the term start
  -- date exists, because the term starts when it is PAID.
  period_start   date,
  period_end     date,
  currency       text not null default 'BDT',
  subtotal       numeric(12, 2) not null default 0,      -- sum of the line items
  discount       numeric(12, 2) not null default 0,
  total_payable  numeric(12, 2) not null default 0,      -- subtotal - discount, computed server-side
  -- DERIVED from building_plan_payments — see the header. Never written by hand.
  amount_paid    numeric(12, 2) not null default 0,
  payment_status text not null default 'unpaid'
                   check (payment_status in ('unpaid', 'partial', 'paid')),
  paid_at        timestamptz,
  -- The terms of the deal, shown to the building on its Plan tab and printed on the invoice.
  -- Free text on purpose: these are negotiated per building and no schema would survive them.
  terms          text,
  -- An optional link the building can pay through itself. There is no gateway integration behind
  -- this — it is whatever URL we hand them (bKash payment link, bank portal, invoice page).
  payment_url    text,
  status         text not null default 'draft'
                   check (status in ('draft', 'sent', 'settled', 'void')),
  issued_at      timestamptz,
  due_on         date,
  note           text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create index if not exists building_plan_invoice_building_idx
  on public.building_plan_invoices (building_id, created_at desc);
create index if not exists building_plan_invoice_status_idx
  on public.building_plan_invoices (payment_status, due_on);

-- =====================================================================================
-- 3. INVOICE LINE ITEMS — this is the entire "the price rises from year 2" model.
-- =====================================================================================
-- Year 1 is a plan line on its own. Year 2 is the same plan line plus "Maintenance & support"
-- plus whatever extra modules the building has taken. Raising a price is composing a different
-- invoice, not editing a tier — which is why no subscription_tiers row is added by this feature.
create table if not exists public.building_plan_invoice_items (
  id          uuid primary key,
  invoice_id  uuid not null references public.building_plan_invoices (id) on delete cascade,
  label       text not null,                          -- "Whole Building plan (12 months)"
  amount      numeric(12, 2) not null default 0,
  sort_order  integer not null default 0,
  created_at  timestamptz not null default now()
);

create index if not exists building_plan_invoice_items_idx
  on public.building_plan_invoice_items (invoice_id, sort_order);

-- =====================================================================================
-- 4. PLAN PAYMENTS — the truth.
-- =====================================================================================
create table if not exists public.building_plan_payments (
  id           uuid primary key,
  payment_no   bigint generated always as identity,    -- the receipt number the building sees
  invoice_id   uuid not null references public.building_plan_invoices (id) on delete cascade,
  building_id  uuid not null,       -- denormalised so a building's payment history is one query
  admin_id     uuid not null,       -- denormalised for the same reason
  amount       numeric(12, 2) not null check (amount > 0),
  paid_on      date not null default current_date,
  method       text not null default 'bank'
                 check (method in ('cash', 'bkash', 'nagad', 'bank', 'card', 'other')),
  reference    text,                -- bKash trx id, bank reference, cheque number
  -- The super admin who entered it. Null when it came from accepting a building's own payment
  -- claim, which is what distinguishes "we collected this" from "they told us they paid".
  recorded_by  uuid,
  note         text,
  created_at   timestamptz not null default now()
);

create index if not exists building_plan_payment_invoice_idx
  on public.building_plan_payments (invoice_id, paid_on);
create index if not exists building_plan_payment_building_idx
  on public.building_plan_payments (building_id, paid_on desc);

-- =====================================================================================
-- 5. REQUESTS — the queue behind the admin console's Buildings menu.
-- =====================================================================================
-- Two things a building sends us, one table, so there is ONE queue to watch and one badge to
-- clear. Same shape as payment_submissions / support_tickets / contact_messages: the building
-- files it, an admin walks the status along and leaves a note the building can read.
create table if not exists public.building_plan_requests (
  id               uuid primary key,
  request_no       bigint generated always as identity,   -- human-facing reference, e.g. "#5"
  building_id      uuid not null references public.buildings (id) on delete cascade,
  admin_id         uuid not null,                         -- the filing building admin
  kind             text not null
                     check (kind in ('renewal', 'payment_claim')),
  message          text,
  -- Populated on a payment_claim only: what the building says it paid. Accepting the claim turns
  -- these into a real building_plan_payments row. Deliberately NOT a payment until an admin has
  -- confirmed it — an unverified claim must never move a term forward.
  claim_amount     numeric(12, 2),
  claim_method     text,
  claim_reference  text,
  status           text not null default 'new'
                     check (status in ('new', 'in_progress', 'quoted', 'closed', 'rejected')),
  admin_notes      text,        -- visible to the building, like payment_submissions.admin_notes
  invoice_id       uuid,        -- the quote raised from this request, once there is one
  reviewed_by      uuid,
  reviewed_at      timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create index if not exists building_plan_request_status_idx
  on public.building_plan_requests (status, created_at desc);
create index if not exists building_plan_request_building_idx
  on public.building_plan_requests (building_id, created_at desc);

-- =====================================================================================
-- 6. NOTIFICATION DEDUPE — what this building has already been told.
-- =====================================================================================
-- Same design as plan_events: the cron CLAIMS a row here before notifying, and only a claim that
-- actually inserted earns a message. `ref` ties the event to the date it belongs to (the expiry,
-- or the pay-by deadline while unpaid), so re-running the cron is a no-op but a RENEWED term is a
-- genuinely new event rather than being swallowed forever.
create table if not exists public.building_plan_events (
  id           uuid primary key,
  building_id  uuid not null,
  admin_id     uuid not null,
  event        text not null
                 check (event in ('pay_due', 'expiring_soon', 'grace_started', 'locked')),
  ref          text not null,        -- the date this event belongs to; '' when there is none
  notified_at  timestamptz not null default now(),
  created_at   timestamptz not null default now()
);

create unique index if not exists building_plan_events_unique_idx
  on public.building_plan_events (building_id, event, ref);

-- =====================================================================================
-- 7. BACKFILL — every building that already exists keeps working.
-- =====================================================================================
-- Without this, every existing building resolves as "never paid" and locks 15 days later, which
-- would be a catastrophic way to ship a billing feature. They are marked paid from today with a
-- one-year term and a BACKFILL note, giving us a year to correct each one's real dates from the
-- new Buildings menu. `on conflict do nothing` keeps the file safe to re-run.
insert into public.building_subscriptions
  (building_id, admin_id, term_months, term_starts_on, expiry_date, pay_by, first_paid_at, notes)
select
  b.id,
  b.admin_id,
  12,
  current_date,
  (current_date + interval '1 year')::date,
  (current_date + interval '15 days')::date,
  now(),
  'BACKFILL — created by ADD_BUILDING_PLANS.sql. Correct the real term dates from the admin console.'
from public.buildings b
on conflict (building_id) do nothing;

-- =====================================================================================
-- 8. RLS
-- =====================================================================================
-- Same posture as every other table here: RLS on with NO policies (deny-all to anon and
-- authenticated) and the default API grants revoked. The backend uses the service-role key.
alter table public.building_subscriptions        enable row level security;
alter table public.building_plan_invoices        enable row level security;
alter table public.building_plan_invoice_items   enable row level security;
alter table public.building_plan_payments        enable row level security;
alter table public.building_plan_requests        enable row level security;
alter table public.building_plan_events          enable row level security;

revoke all on public.building_subscriptions      from anon, authenticated;
revoke all on public.building_plan_invoices      from anon, authenticated;
revoke all on public.building_plan_invoice_items from anon, authenticated;
revoke all on public.building_plan_payments      from anon, authenticated;
revoke all on public.building_plan_requests      from anon, authenticated;
revoke all on public.building_plan_events        from anon, authenticated;
