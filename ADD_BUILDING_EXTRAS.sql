-- Whole Building plan, phase 3: AMENITIES and INCOME SOURCES.
-- Run once in the Supabase SQL editor (service role). Idempotent — safe to re-run.
-- Requires ADD_BUILDINGS.sql (buildings).
--
-- These two tables are deliberately THIN CONFIG LISTS, not ledgers. They hold definitions —
-- "this building has a lift that costs 8,000/month to run", "we rent the rooftop for 12,000" —
-- and nothing else. Every actual transaction still lives in account_transactions, which already
-- exists, is already bundled with the Whole Building tier, and already has the reporting behind
-- it. Duplicating money into a second place is how two totals start disagreeing.
--
-- What they are FOR:
--   * building_amenities feeds the itemised breakdown printed on a service-charge statement
--     (phase 4) and the expense-category picker, so a building admin books "Lift maintenance"
--     by choosing it rather than retyping it into a free-text field every month.
--   * building_income_sources does the same for the non-rent money a building collects —
--     rooftop, parking, signboard, community hall — which otherwise arrives as free text in
--     account_transactions.category and can never be totalled reliably.
--
-- Amounts are numeric(12, 2) and are DEFAULTS, never balances. Nothing derives from them.

-- =====================================================================================
-- 1. AMENITIES (what the building runs, and what it costs)
-- =====================================================================================
create table if not exists public.building_amenities (
  id           uuid primary key,
  building_id  uuid not null references public.buildings (id) on delete cascade,
  name         text not null,                            -- "Lift", "Generator", "Security guard"
  description  text,
  monthly_cost numeric(12, 2) not null default 0,         -- indicative running cost, a default
  is_active    boolean not null default true,             -- soft retire without losing the history
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index if not exists building_amenities_building_idx
  on public.building_amenities (building_id, is_active);

-- =====================================================================================
-- 2. INCOME SOURCES (the non-rent money a building collects)
-- =====================================================================================
create table if not exists public.building_income_sources (
  id             uuid primary key,
  building_id    uuid not null references public.buildings (id) on delete cascade,
  name           text not null,                          -- "Rooftop rent", "Car parking"
  category       text,                                   -- mirrors account_transactions.category
  default_amount numeric(12, 2) not null default 0,
  note           text,
  is_active      boolean not null default true,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create index if not exists building_income_sources_building_idx
  on public.building_income_sources (building_id, is_active);

-- =====================================================================================
-- 3. RLS
-- =====================================================================================
-- Same posture as every other table here: RLS on with NO policies (deny-all to anon and
-- authenticated) and the default API grants revoked. The backend uses the service-role key.
alter table public.building_amenities      enable row level security;
alter table public.building_income_sources enable row level security;

revoke all on public.building_amenities      from anon, authenticated;
revoke all on public.building_income_sources from anon, authenticated;
