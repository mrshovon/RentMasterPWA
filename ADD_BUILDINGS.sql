-- Whole Building plan, phase 1: the BUILDING and the owners that sit under it.
-- Run once in the Supabase SQL editor (service role). Idempotent — safe to re-run.
--
-- The hierarchy this completes:  super admin -> building admin -> owner -> tenant.
-- A building admin is an ordinary Supabase auth user whose user_metadata.role is
-- 'building_admin'. It is NOT in user_profiles.role: that column is a Postgres enum with
-- only 'owner' and 'tenant', and an INSERT trigger on auth.users mirrors the metadata role
-- into it, so createUser() with any other value fails outright. Building admins are therefore
-- created as 'owner' and promoted with updateUserById (the trigger is INSERT-only), and their
-- user_profiles row keeps role 'owner' — which also keeps the properties.owner_id ->
-- user_profiles.id foreign key working, so a building admin can hold its own rentable spaces.
--
-- WHY SO FEW TABLES: the building admin is an "owner-shaped" account. Their own properties,
-- tenants, rent invoices, staff, accounts, notices and reminders all reuse the EXISTING tables
-- with owner_id = <their auth uid>. Only the building itself and its owner roster are new here.
--
-- admin_id and owner_id are deliberately NOT foreign keys (same rationale as staff / accounts /
-- reminders): a missing user_profiles stub must never make a record un-writable, and — more
-- importantly — a FK to user_profiles(id) is NO ACTION, so it would fire during
-- auth.admin.deleteUser AFTER the delete cascade has already run, leaving a half-deleted
-- account. The super-admin delete route purges these tables explicitly instead.

-- =====================================================================================
-- 1. BUILDINGS (one per building admin)
-- =====================================================================================
create table if not exists public.buildings (
  id              uuid primary key,
  building_no     bigint generated always as identity,   -- human-facing reference, e.g. "#3"
  admin_id        uuid not null,                         -- auth.users.id of the building admin
  name            text not null,                         -- "Rahman Tower"
  address         text,
  city            text,
  letterhead_url  text,                                  -- Supabase Storage; header of printed notices
  signatory_name  text,                                  -- printed under the authorised signature
  signatory_title text,                                  -- "Chairman", "Secretary", …
  notes           text,
  is_active       boolean not null default true,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

-- One building per admin today. A unique index rather than a check so the "one" rule is the
-- database's, not the route's; relaxing it later is a one-line index swap.
create unique index if not exists buildings_admin_idx on public.buildings (admin_id);

-- The signature IMAGE is intentionally not a column here: /api/admin/owner/signature already
-- stores one in user_metadata for any auth user, and a building admin is one.

-- =====================================================================================
-- 2. BUILDING OWNERS (the roster — which flat owners belong to this building)
-- =====================================================================================
create table if not exists public.building_owners (
  building_id            uuid not null references public.buildings (id) on delete cascade,
  owner_id               uuid not null,                  -- auth.users.id of the flat owner. NOT a FK.
  unit_label             text,                           -- "Flat 4B" — free text, independent of properties.id
  default_service_charge numeric(12, 2) not null default 0,  -- pre-fills each month's invoice
  joined_at              timestamptz not null default now(),
  is_active              boolean not null default true,  -- soft detach without losing invoice history
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  -- owner_id alone is the PK on purpose: it enforces "an owner belongs to at most one building"
  -- AND is the index for buildingMembershipOf(), which runs on every owner plan resolution.
  primary key (owner_id)
);

create index if not exists building_owners_building_idx
  on public.building_owners (building_id, is_active);

-- =====================================================================================
-- 3. WHICH PLANS BUNDLE THE PAID MODULES
-- =====================================================================================
-- Re-stated from ADD_STAFF.sql / ADD_ACCOUNTS.sql rather than assumed: this script must not
-- depend on the order those were run in. Both are `if not exists`, so re-stating costs nothing.
alter table public.subscription_tiers
  add column if not exists staff_included boolean not null default false;
alter table public.subscription_tiers
  add column if not exists accounts_included boolean not null default false;

-- The Whole Building / enterprise ("contact us") tiers include both out of the box. Member
-- owners inherit this, because their resolved plan keeps the real 'whole_building' tier id.
update public.subscription_tiers
   set staff_included = true, accounts_included = true
 where billing_interval = 'custom';

-- =====================================================================================
-- 4. RLS
-- =====================================================================================
-- Same posture as ENABLE_RLS.sql / ADD_ACCOUNTS.sql: RLS on with NO policies (deny-all to anon
-- and authenticated) and the default API grants revoked. The backend reaches these tables with
-- the service-role key, which bypasses RLS entirely.
alter table public.buildings       enable row level security;
alter table public.building_owners enable row level security;

revoke all on public.buildings       from anon, authenticated;
revoke all on public.building_owners from anon, authenticated;
