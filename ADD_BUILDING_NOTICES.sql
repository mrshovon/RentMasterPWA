-- Whole Building plan, phase 4: BUILDING NOTICES (the printable record).
-- Run once in the Supabase SQL editor (service role). Idempotent — safe to re-run.
-- Requires ADD_BUILDINGS.sql (buildings).
--
-- A building notice exists twice, on purpose:
--
--   1. HERE, as one canonical row — the thing that gets printed on the building's letterhead
--      with a reference number, an issue date and an authorised signature. A physical notice
--      pinned to a lift door needs a stable reference someone can quote back; a fan-out row
--      cannot provide that, because there are N of them and they carry no shared identity.
--
--   2. In the EXISTING `notices` table, as the in-app delivery. The route fans this row out into
--      one `individual_owner` notice per flat owner (a single batched insert), or a single
--      `all_tenants` row for the building's own tenants — exactly the shapes the owner and
--      tenant feeds already query for.
--
-- WHY NOT just widen `notices`: its `target_scope` CHECK would need a new value, and
-- ADMIN_ONLY_SCOPES in app/api/admin/notices/route.ts would have to be relaxed to let a
-- non-admin post `individual_owner` — which would let ANY owner address ANY other owner by uid.
-- The fan-out is done server-side from the building route instead, where the target list comes
-- from the building's own roster and can never be supplied by the caller.
--
-- No DDL on `notices` at all. This table is additive and nothing outside phase 4 reads it.

create table if not exists public.building_notices (
  id              uuid primary key,
  notice_no       bigint generated always as identity,   -- fallback reference when none is typed
  building_id     uuid not null references public.buildings (id) on delete cascade,
  title           text not null,
  content         text not null,
  audience        text not null default 'all_owners'
                    check (audience in ('all_owners', 'all_tenants', 'individual_owner')),
  target_owner_id uuid,                                   -- set only when audience is individual_owner
  issued_on       date not null default current_date,     -- the date printed on the letter
  reference_no    text,                                   -- e.g. "RT/2026/14"; falls back to "#<notice_no>"
  -- How many in-app notices the fan-out actually created. Recorded so the admin can see that a
  -- notice reached people, rather than having to trust that it did.
  delivered_count integer not null default 0,
  created_at      timestamptz not null default now()
);

create index if not exists building_notices_building_idx
  on public.building_notices (building_id, issued_on desc);

-- An individual notice must name its target, and a broadcast must not. Same posture as the
-- notices_target_present_check on the existing notices table.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'building_notices_target_present_check'
  ) then
    alter table public.building_notices
      add constraint building_notices_target_present_check
      check (
        (audience = 'individual_owner' and target_owner_id is not null)
        or (audience <> 'individual_owner' and target_owner_id is null)
      );
  end if;
end $$;

-- =====================================================================================
-- RLS
-- =====================================================================================
-- RLS on with NO policies (deny-all to anon and authenticated) and the default API grants
-- revoked. The backend reaches this table with the service-role key.
alter table public.building_notices enable row level security;
revoke all on public.building_notices from anon, authenticated;
