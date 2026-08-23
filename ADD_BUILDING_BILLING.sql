-- Whole Building plan, phase 2: SERVICE-CHARGE INVOICES from the building admin to its owners.
-- Run once in the Supabase SQL editor (service role). Idempotent — safe to re-run.
-- Requires ADD_BUILDINGS.sql (buildings, building_owners).
--
-- This is the rent-invoice cycle again, one level up: the building admin bills each flat owner a
-- monthly service charge, the owner sees it in their own dashboard, and the building admin records
-- the money when it arrives. It deliberately mirrors billing_ledgers / billing_payments rather than
-- inventing a second model, because the rule that makes that one correct is worth copying exactly:
--
--   *** building_service_payments ROWS ARE THE TRUTH. ***
--   An invoice's amount_paid, payment_status and paid_at are DERIVED from them by
--   recalcBuildingInvoice() in lib/building-billing.ts and written by nothing else.
--
-- Differences from the rent cycle, all deliberate:
--   * No 'sent' status. That value exists on billing_ledgers because a TENANT can claim "I've paid,
--     please confirm" from their own app. Service-charge invoices are recorded by the building
--     admin alone, so the ladder is just unpaid -> partial -> paid.
--   * No property_id. A service charge is billed to a PERSON's share of the building, not to a
--     unit row — building_owners.unit_label is the human label and it is free text on purpose.
--   * Paying one books an income row with source = 'billing' (NOT a new source value). Reusing it
--     avoids a CHECK-constraint change on account_transactions, which is a live table holding real
--     money; source_ref is the PAYMENT id, so it can never collide with a rent ledger id.
--
-- building_id/admin_id/owner_id follow the house convention: auth uids are plain uuid columns and
-- never foreign keys to user_profiles (see the header of ADD_BUILDINGS.sql for why that FK is
-- actively harmful). building_id DOES reference buildings(id), which is a table these migrations
-- created and therefore a real uuid — no text/uuid PK trap here.

-- =====================================================================================
-- 1. INVOICES
-- =====================================================================================
create table if not exists public.building_service_invoices (
  id                   uuid primary key,
  invoice_no           bigint generated always as identity,  -- human-facing reference, e.g. "#41"
  building_id          uuid not null references public.buildings (id) on delete cascade,
  admin_id             uuid not null,                        -- who issued it (the building admin)
  owner_id             uuid not null,                        -- the flat owner being billed
  billing_month        text not null,                        -- "YYYY-MM"
  service_charge       numeric(12, 2) not null default 0,    -- pre-filled from building_owners
  extra_charge         numeric(12, 2) not null default 0,
  extra_charge_remarks text,
  discount             numeric(12, 2) not null default 0,
  total_payable        numeric(12, 2) not null default 0,    -- (service + extra) - discount
  -- DERIVED — see the header. Never written by hand.
  amount_paid          numeric(12, 2) not null default 0,
  payment_status       text not null default 'unpaid'
                         check (payment_status in ('unpaid', 'partial', 'paid')),
  paid_at              timestamptz,
  note                 text,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

-- One service-charge invoice per owner per month. This is what makes "generate for this month"
-- safe to press twice: the second attempt collides here instead of quietly double-billing someone.
create unique index if not exists building_invoice_owner_month_idx
  on public.building_service_invoices (owner_id, billing_month);

create index if not exists building_invoice_building_idx
  on public.building_service_invoices (building_id, billing_month desc);
create index if not exists building_invoice_owner_idx
  on public.building_service_invoices (owner_id, created_at desc);

-- =====================================================================================
-- 2. PAYMENTS (the truth)
-- =====================================================================================
create table if not exists public.building_service_payments (
  id           uuid primary key,
  payment_no   bigint generated always as identity,
  invoice_id   uuid not null references public.building_service_invoices (id) on delete cascade,
  building_id  uuid not null,        -- denormalised so a building's collections are one query
  owner_id     uuid not null,        -- denormalised for the same reason
  amount       numeric(12, 2) not null check (amount > 0),
  paid_on      date not null default current_date,
  method       text not null default 'cash'
                 check (method in ('cash', 'bkash', 'nagad', 'bank', 'other')),
  note         text,
  created_at   timestamptz not null default now()
);

create index if not exists building_payment_invoice_idx
  on public.building_service_payments (invoice_id, paid_on);
create index if not exists building_payment_building_idx
  on public.building_service_payments (building_id, paid_on desc);

-- =====================================================================================
-- 3. RLS
-- =====================================================================================
-- Same posture as every other table here: RLS on with NO policies (deny-all to anon and
-- authenticated) and the default API grants revoked. The backend uses the service-role key.
alter table public.building_service_invoices enable row level security;
alter table public.building_service_payments enable row level security;

revoke all on public.building_service_invoices from anon, authenticated;
revoke all on public.building_service_payments from anon, authenticated;
