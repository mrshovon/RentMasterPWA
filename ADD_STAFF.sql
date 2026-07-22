-- Staff module: owners record the people who work for them (caretaker, guard, cleaner, …),
-- optionally attach each to one property, and log salary payments as they pay them.
-- Run once in the Supabase SQL editor (service role). Idempotent — safe to re-run.
--
-- Staff is a COMMERCIAL feature, not a free one:
--   * the Whole Building tier (billing_interval = 'custom') includes it — see staff_included below;
--   * every other plan treats it as a paid add-on the super-admin grants per owner via owner_addons.
-- The admin grant is absolute: it works on any tier, free included (trials, special cases).
--
-- Salary is an AD-HOC PAYMENTS LOG, deliberately not a payroll cycle: staff.monthly_salary is the
-- agreed figure kept for reference, and each real payment is one staff_payments row. There is no
-- month-by-month schedule to generate, reconcile or fall out of sync.
--
-- owner_id is intentionally NOT a foreign key (same rationale as reminders / contact_messages /
-- support_tickets: a missing user_profiles stub must never make a staff record un-writable).

-- =====================================================================================
-- 1. STAFF
-- =====================================================================================
create table if not exists public.staff (
  id              uuid primary key,
  staff_no        bigint generated always as identity,   -- human-facing reference, e.g. "#7"
  owner_id        uuid not null,                          -- auth.users.id of the owner
  name            text not null,
  phone           text,
  designation     text,                                   -- Caretaker / Guard / Cleaner / …
  -- NOTE: properties.id is TEXT ("UNIT-1234", see generateUniqueUnitId in the properties route),
  -- so this column is text, NOT uuid. Nullable: property assignment is optional.
  property_id     text references public.properties (id) on delete set null,
  monthly_salary  numeric(12, 2) not null default 0,      -- agreed salary; payments are logged separately
  joining_date    date,
  nid_number      text,
  nid_doc_url     text,                                   -- public URL in the docs bucket (staff/ folder)
  photo_url       text,
  address         text,
  notes           text,
  is_active       boolean not null default true,          -- soft "no longer employed" without losing history
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index if not exists staff_owner_idx    on public.staff (owner_id);
create index if not exists staff_property_idx on public.staff (property_id);

-- =====================================================================================
-- 2. STAFF PAYMENTS (ad-hoc log)
-- =====================================================================================
create table if not exists public.staff_payments (
  id           uuid primary key,
  payment_no   bigint generated always as identity,
  staff_id     uuid not null references public.staff (id) on delete cascade,
  -- Denormalised so the owner-wide payment log needs no join, and so ownership can be enforced
  -- on the payment row itself rather than trusted through staff_id.
  owner_id     uuid not null,
  amount       numeric(12, 2) not null,
  paid_on      date not null,
  method       text not null default 'cash'
                 check (method in ('cash', 'bkash', 'nagad', 'bank', 'other')),
  note         text,
  created_at   timestamptz not null default now()
);

create index if not exists staff_payments_staff_idx on public.staff_payments (staff_id);
create index if not exists staff_payments_owner_idx on public.staff_payments (owner_id, paid_on desc);

-- =====================================================================================
-- 3. OWNER ADD-ONS (generic per-owner feature grants)
-- =====================================================================================
-- Deliberately NOT stored in auth user_metadata, where permissions_revoked lives: user_metadata is
-- writable by the user themselves via supabase.auth.updateUser({ data }) with their own access token
-- and the public anon key, both of which the frontend ships. A paid feature flag kept there could be
-- self-granted. This table is service-role only. It is keyed by addon_key so future paid features
-- reuse it without another migration.
create table if not exists public.owner_addons (
  owner_id    uuid not null,
  addon_key   text not null,                              -- 'staff' today
  enabled     boolean not null default true,
  granted_by  uuid,                                       -- the admin who flipped it
  granted_at  timestamptz not null default now(),
  note        text,
  primary key (owner_id, addon_key)
);

create index if not exists owner_addons_key_idx on public.owner_addons (addon_key, enabled);

-- =====================================================================================
-- 4. WHICH PLANS INCLUDE STAFF
-- =====================================================================================
-- A column rather than a hardcoded tier name, so "which plans include Staff" stays editable from
-- the admin console instead of requiring a code change.
alter table public.subscription_tiers
  add column if not exists staff_included boolean not null default false;

-- The Whole Building / enterprise ("contact us") tiers include it out of the box.
update public.subscription_tiers set staff_included = true where billing_interval = 'custom';

-- =====================================================================================
-- 5. RLS
-- =====================================================================================
-- Same posture as ENABLE_RLS.sql / ADD_REMINDERS.sql: RLS on with NO policies (deny-all to anon and
-- authenticated) and the default API grants revoked. The backend reaches these tables with the
-- service-role key, which bypasses RLS entirely.
alter table public.staff          enable row level security;
alter table public.staff_payments enable row level security;
alter table public.owner_addons   enable row level security;

revoke all on public.staff          from anon, authenticated;
revoke all on public.staff_payments from anon, authenticated;
revoke all on public.owner_addons   from anon, authenticated;
