-- A property the owner lives in themselves.
-- Run once in the Supabase SQL editor (service role). Idempotent — safe to re-run.
--
-- THE PROBLEM
--   properties.is_vacant is a boolean, so a flat its owner LIVES IN reads as "Vacant" — an empty
--   unit they are apparently failing to let. A flat owner in a building typically occupies one of
--   their flats and rents the rest, so this is the normal case, not an edge one.
--
-- WHY A NEW COLUMN AND NOT AN ENUM ON is_vacant
--   Three reasons, any one sufficient:
--     1. `properties` is BASE SCHEMA — hand-built in the dashboard, no CREATE TABLE in this repo.
--        Widening a column's type on a live hand-made table is not a change to make casually.
--     2. is_vacant is typed `boolean` in an EXPLICITLY-NAMED select the tenant portal depends on
--        (app/api/admin/tenants/me/route.ts) and in types/api.ts. A type change breaks the client
--        mid-rollout, on the one screen a tenant sees.
--     3. is_vacant is force-written by six uncoordinated paths — property create, the vacate flow,
--        tenant onboard, and both sides of a tenant move — three of which are fire-and-forget side
--        effects that only console.error on failure. A boolean they can keep setting blindly is
--        safe; a tri-state they would corrupt.
--
-- THE MODEL
--   is_vacant keeps meaning exactly what it means today: NO TENANT. Self-occupancy is orthogonal to
--   it, and the display state is derived, never stored:
--
--       disabled (plan limit)  >  occupied (!is_vacant)  >  self-occupied  >  vacant
--
--   A tenant being assigned CLEARS is_self_occupied — you cannot let a flat you live in — which is
--   done in the tenant routes rather than by a constraint, because those writes are already
--   best-effort side effects and a CHECK would turn a soft failure into a hard one.
--
-- NOT NULL DEFAULT false is safe here: Postgres 11+ stores a non-volatile default in the catalogue
-- rather than rewriting the table, so this does not lock `properties` for a scan.
--
-- Follows ADD_TENANT_NID_AND_RECEIPT_NAME.sql, the only other file that alters this table.

do $$
begin
  if to_regclass('public.properties') is null then
    raise notice 'ADD_PROPERTY_SELF_OCCUPIED: properties missing — SKIPPED. Something is very wrong.';
    return;
  end if;

  alter table public.properties
    add column if not exists is_self_occupied boolean not null default false;

  raise notice 'ADD_PROPERTY_SELF_OCCUPIED: applied. properties.is_self_occupied is available; every existing row is false, which is what they already meant.';
end $$;
