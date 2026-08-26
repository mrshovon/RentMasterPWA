-- Deletion audit: money paid TO BARI360 must outlive the account that paid it.
-- Run once in the Supabase SQL editor (service role). Idempotent — safe to re-run.
-- Requires ADD_BUILDING_PLANS.sql (building_plan_invoices).
--
-- ⚠️ RUN THIS BEFORE DEPLOYING the backend change that ships with it. Unlike the other building
-- migrations — which lib/building.ts is written to tolerate the absence of — this one IS the
-- change. Deploy first and the next building deletion still cascades its plan invoices into
-- nothing, which is exactly the data loss this file exists to stop.
--
-- THE PROBLEM
--   Deleting a building admin deletes their `buildings` row (app/api/super-admin/owners/[id]),
--   and `building_plan_invoices.building_id` was `not null references buildings(id) on delete
--   cascade`. The invoice is in turn the parent of building_plan_invoice_items and
--   building_plan_payments, both cascading. So one DELETE silently destroyed the entire record of
--   what we billed a building and what they paid us — the numbers a financial audit is made of,
--   and the only thing behind the receipt numbers the building already holds on paper.
--
-- THE FIX, and why it is a DROP rather than an ON DELETE SET NULL
--   Setting building_id to null would preserve the rows but lose the grouping: invoices and
--   payments from one building would become an undifferentiated heap, and the archive screen
--   could not put a deleted building back together. Dropping the constraint keeps the column and
--   its value — a plain uuid pointing at a building that no longer exists, which is precisely
--   what building_plan_payments.building_id has always been (ADD_BUILDING_PLANS.sql:153) and what
--   every uid column in this schema is by standing decision. See ADD_BUILDINGS.sql:17-21.
--
--   The two child tables need no change: they cascade off the INVOICE, and the invoice now
--   survives. Everything else that hangs off buildings — building_subscriptions,
--   building_plan_requests, the service-charge tables, amenities, income sources, notices —
--   keeps its cascade on purpose. None of it is money paid to us.
--
-- WHAT THE SNAPSHOT COLUMNS ARE FOR
--   Once the buildings row is gone there is nothing left to join to for a name. Same reasoning as
--   payment_submissions.owner_email (ADD_PAYMENT_SUBMISSIONS.sql:20): an audit row that cannot
--   name its counterparty is not an audit row.
--
-- WHY THE WHOLE FILE IS ONE GUARDED BLOCK
--   ADD_BUILDING_PLANS.sql is still listed as pending in MIGRATIONS.md. A bare ALTER on a table
--   that does not exist aborts the file, and the SQL editor runs a file as ONE transaction — so a
--   single 42P01 would silently apply nothing at all, which is precisely how ADD_PLAN_TENURE.sql
--   failed on its first attempt. The to_regclass guard is the discipline MIGRATIONS.md asks for.
--   ⚠️ If this prints the "skipped" notice, run ADD_BUILDING_PLANS.sql first and re-run this file.

do $$
begin
  if to_regclass('public.building_plan_invoices') is null then
    raise notice 'ADD_DELETION_AUDIT: building_plan_invoices does not exist — SKIPPED. Run ADD_BUILDING_PLANS.sql first, then re-run this file.';
    return;
  end if;

  -- ---------------------------------------------------------------- 1. break the cascade
  -- The constraint name is Postgres's generated default for the inline `references` at
  -- ADD_BUILDING_PLANS.sql:90. `if exists` makes a re-run, or a database where it was already
  -- dropped by hand, a no-op.
  alter table public.building_plan_invoices
    drop constraint if exists building_plan_invoices_building_id_fkey;

  -- ---------------------------------------------------------------- 2. identity snapshot
  alter table public.building_plan_invoices add column if not exists building_name text;
  alter table public.building_plan_invoices add column if not exists admin_email   text;

  -- Backfill from the live buildings rows. Only fills nulls, so re-running never overwrites a
  -- snapshot with a name that has since been edited — the snapshot records what the building was
  -- called when we billed it.
  update public.building_plan_invoices i
     set building_name = b.name
    from public.buildings b
   where b.id = i.building_id
     and i.building_name is null;

  -- ---------------------------------------------------------------- 3. the archive lookup
  -- /api/super-admin/buildings/archived lists the invoices of a deleted building. The existing
  -- indexes are on (building_id, created_at) and (payment_status, due_on); the archive reads by
  -- the billing party, who is the one identifier that outlives everything.
  create index if not exists building_plan_invoices_admin_idx
    on public.building_plan_invoices (admin_id, created_at desc);

  raise notice 'ADD_DELETION_AUDIT: applied.';
end $$;
