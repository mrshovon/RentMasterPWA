-- Whole Building, phase 6b: close the transitional invoice guard.
-- Run in the Supabase SQL editor (service role). Idempotent — safe to re-run.
--
-- ⚠️ RUN THIS DAYS AFTER ADD_BUILDING_OWNER_FLATS.sql AND after the code that writes flat_id has
-- been live long enough that no instance predating it is still serving. It is pure hygiene: the
-- feature works completely without it. Running it EARLY is the one genuinely destructive mistake
-- available here — flat_id NOT NULL makes every invoice insert from an older instance fail with
-- 23502, and the legacy guard it drops is what was protecting those inserts from double-billing.
--
-- WHAT IT DOES
--   ADD_BUILDING_OWNER_FLATS.sql deliberately left flat_id nullable and kept a partial unique index
--   on (owner_id, billing_month) where flat_id is null, so that pre-existing rows and any instance
--   still running the old code stayed guarded through the rollout. Once every invoice has a flat,
--   both of those are dead weight: the partial index can never match a row, and the nullability is
--   a lie about the data. This file makes flat_id NOT NULL and removes the legacy index, leaving
--   (flat_id, billing_month) as the sole guard.
--
-- WHY IT REFUSES RATHER THAN FAILS
--   A null flat_id at this point means something wrote an invoice without one — an unfinished
--   rollout, or a code path that was missed. A bare `alter ... set not null` would abort, and
--   because the SQL editor runs a file as one transaction you would be told nothing about WHICH
--   rows, only that the whole file rolled back. Counting first and raising a notice turns a dead
--   end into an instruction.
--
-- WHY SET NOT NULL COMES BEFORE THE DROP
--   If the alter fails, the transaction rolls back with the legacy guard still in place. Reversed,
--   a failure would leave the table with no guard on the null-flat rows at all.

do $$
declare v_nulls bigint;
begin
  if to_regclass('public.building_owner_flats') is null then
    raise notice 'FINALIZE_BUILDING_FLAT_INVOICES: building_owner_flats missing — SKIPPED. Run ADD_BUILDING_OWNER_FLATS.sql first.';
    return;
  end if;

  select count(*) into v_nulls from public.building_service_invoices where flat_id is null;

  if v_nulls > 0 then
    raise notice 'FINALIZE_BUILDING_FLAT_INVOICES: % invoice(s) still have no flat_id — SKIPPED. Either an instance predating the flats deploy is still serving, or something wrote an invoice without a flat. Find them with:', v_nulls;
    raise notice '    select id, building_id, owner_id, billing_month from public.building_service_invoices where flat_id is null;';
    raise notice '  Point each at a building_owner_flats row, then re-run this file.';
    return;
  end if;

  alter table public.building_service_invoices alter column flat_id set not null;

  -- Only now. With no null flat_id possible the partial index can never match a row, and
  -- building_invoice_flat_month_idx covers every row in the table.
  drop index if exists public.building_invoice_legacy_owner_month_idx;

  raise notice 'FINALIZE_BUILDING_FLAT_INVOICES: applied. flat_id is NOT NULL and (flat_id, billing_month) is the sole guard.';
end $$;
