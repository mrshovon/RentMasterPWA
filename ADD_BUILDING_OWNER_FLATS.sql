-- Whole Building, phase 6: ONE OWNER, SEVERAL FLATS, ONE LOGIN.
-- Run once in the Supabase SQL editor (service role). Idempotent — safe to re-run.
-- Requires ADD_BUILDINGS.sql, ADD_BUILDING_BILLING.sql and ADD_BUILDING_LOGIN_IDS.sql.
--
-- ⚠️ RUN THIS BEFORE DEPLOYING the code that ships with it — the opposite of ADD_BUILDINGS and
-- ADD_BUILDING_BILLING, which were safe code-first because lib/building.ts reads a missing table
-- as "no building". This one is not tolerable that way: the new code SELECTs a table and INSERTs
-- columns that only exist once this has run, so deploying first takes owner creation and invoice
-- generation down with PGRST205/PGRST204. Running it EARLY costs nothing — every statement below
-- is additive, and the code currently in production neither reads the new table nor writes the new
-- columns. That is true even of the index swap; see THE GUARD SPLIT below.
--
-- THE PROBLEM
--   A flat owner can own more than one flat. Today they cannot be represented that way: the
--   building admin has to create a separate account per flat, so one person signs in three times
--   to manage three flats. One flat per owner is enforced in two places — building_owners'
--   primary key, and the (owner_id, billing_month) unique index on the invoices.
--
-- WHAT CHANGES, AND WHAT DELIBERATELY DOES NOT
--
--   building_owners STAYS EXACTLY AS IT IS: one row per owner, primary key (owner_id).
--     That PK is not merely a rule — it is the index buildingMembershipOf() uses on EVERY owner
--     plan resolution (2-3 times per billing write, lib/subscription.ts), and that function ends
--     in .maybeSingle(), whose failure branch resolves the owner to null — no building, therefore
--     the FREE plan — and caches it for 60 seconds. Widening building_owners to one row per flat
--     would make "this owner bought a second flat" a SILENT PLAN DOWNGRADE for that person, with
--     their excess properties going view-only and Staff/Accounts switching off, indistinguishable
--     from a network blip. So the flats live in a CHILD table and the plan-resolution path is
--     never taught that they exist. Nothing in lib/building.ts's existing functions changes.
--
--   building_owners.unit_label and .flat_no become LOGIN PROVENANCE and nothing else: the flat the
--     person's identifier was built from, at creation, forever. owners/[id]/route.ts already states
--     the identifier is set once and never regenerated; this gives the two columns behind it a
--     single honest meaning. unit_label is additionally kept MIRRORING the primary flat's label, so
--     any read path still keyed on the owner degrades to "their main flat" rather than to null.
--
--   building_owners.default_service_charge is FROZEN — read and written by nothing after this.
--     A service charge belongs to a FLAT: a three-bed and a ground-floor shop do not pay the same
--     share, and one number per person cannot express that. It moves to the flat row. The column is
--     LEFT IN PLACE rather than dropped: the SQL editor runs a file as one transaction, a dropped
--     column is not recoverable from the app, and leaving it means rolling the code deploy back
--     still works. A later cleanup file may drop it once this has been live a while.
--
-- WHY building_owner_flats HAS NO FOREIGN KEY TO building_owners
--   Detaching an owner DELETEs their building_owners row and deliberately keeps their invoices
--   (owners/[id] DELETE, and the console's confirm text tells admins so). Their flat rows must
--   survive the same way, or a historical invoice loses the only thing that can name which flat it
--   was for. building_id DOES reference buildings(id) on delete cascade, exactly as building_owners
--   does — deleting a building really does take its whole roster with it.
--
-- WHY building_service_invoices.flat_id IS NOT A FOREIGN KEY EITHER
--   The standing decision of ADD_BUILDINGS.sql:17-21, one level down. Deleting a building cascades
--   BOTH the flats and (through building_id) nothing on the invoices — so an FK between flats and
--   invoices would make that delete depend on trigger ordering. This project has already been bitten
--   by exactly that shape (properties.owner_id -> user_profiles). A plain uuid that may point at a
--   row which no longer exists is what building_plan_payments.building_id has always been, and the
--   flat_label snapshot below is what keeps such a row readable without the join.
--
-- WHY THERE IS A flat_label SNAPSHOT ON THE INVOICE
--   Same reasoning as building_plan_invoices.building_name (ADD_DELETION_AUDIT.sql) and
--   payment_submissions.owner_email: once the flat row is gone — or once the owner holds three of
--   them — the invoice must be able to name its own flat with no join. Every receipt, cutting slip,
--   statement row and accounts note reads THIS, which is what stops six separate print paths having
--   to learn a flats lookup, and what stops all three of a Karim's receipts printing "Flat 3B".
--
-- WHY THE WHOLE FILE IS ONE GUARDED BLOCK
--   The SQL editor runs a file as ONE transaction, so a bare ALTER on a missing table would abort
--   everything and silently apply nothing — which is how ADD_PLAN_TENURE.sql failed on its first
--   attempt. The to_regclass guard is the discipline MIGRATIONS.md asks for.

do $$
declare
  v_roster   bigint;
  v_flats    bigint;
  v_orphans  bigint;
  v_unlinked bigint;
  v_noprop   bigint;
begin
  if to_regclass('public.building_owners') is null
     or to_regclass('public.building_service_invoices') is null then
    raise notice 'ADD_BUILDING_OWNER_FLATS: building_owners / building_service_invoices missing — SKIPPED. Run ADD_BUILDINGS.sql and ADD_BUILDING_BILLING.sql first, then re-run this file.';
    return;
  end if;

  -- ================================================================= 1. THE FLATS
  create table if not exists public.building_owner_flats (
    id                     uuid primary key,
    building_id            uuid not null references public.buildings (id) on delete cascade,
    owner_id               uuid not null,                 -- auth.users.id. NOT a FK — see header.
    unit_label             text,                          -- "Flat 4B" — free text, what prints
    flat_no                text,                          -- the normalised token ("4b")
    default_service_charge numeric(12, 2) not null default 0,
    -- The flat this owner's LOGIN was built from, and the one every back-compat read path falls
    -- back to when a caller names an owner instead of a flat. Exactly one per (building, owner)
    -- among the live rows — enforced by the partial unique index below.
    is_primary             boolean not null default false,
    -- The rentable unit auto-created alongside this flat, so the owner can put a tenant in it,
    -- bill rent and print receipts. ⚠️ properties.id is TEXT — the base schema was built by hand
    -- (MIGRATIONS.md) — so declaring this uuid fails with 42804. Nullable on purpose: a flat whose
    -- property creation failed, or one that predates this feature, is still a perfectly good flat.
    property_id            text,
    joined_at              timestamptz not null default now(),
    is_active              boolean not null default true,  -- soft detach without losing history
    created_at             timestamptz not null default now(),
    updated_at             timestamptz not null default now()
  );

  -- The per-owner list: the roster screen, the statement, and every "which flat did you mean"
  -- fallback read this. The most common query in the feature.
  create index if not exists building_owner_flats_owner_idx
    on public.building_owner_flats (owner_id, created_at);

  -- The generate-a-month enumeration.
  create index if not exists building_owner_flats_building_idx
    on public.building_owner_flats (building_id, is_active);

  -- One primary per owner per building, among the LIVE rows. Scoped to is_active as well as
  -- is_primary so that deactivating a flat immediately makes room for its replacement, instead of
  -- forcing the route to clear the flag first and leaving a window with no primary at all.
  create unique index if not exists building_owner_flats_primary_idx
    on public.building_owner_flats (building_id, owner_id)
    where is_primary and is_active;

  -- Two flats may not claim the same rentable unit. NOT the same thing as unique(unit_label):
  -- flat labels are deliberately NOT unique per building, for exactly the reason flat_no is not
  -- (ADD_BUILDING_LOGIN_IDS.sql:44-49) — two co-owners of one flat are two people, two roster rows
  -- and two flat rows, and the "-2" login suffix exists to serve precisely that.
  create unique index if not exists building_owner_flats_property_idx
    on public.building_owner_flats (property_id)
    where property_id is not null;

  alter table public.building_owner_flats enable row level security;
  revoke all on public.building_owner_flats from anon, authenticated;

  -- ================================================================= 2. BACKFILL: THE ROSTER
  -- Every existing roster row becomes exactly ONE flat carrying its current label, token and
  -- charge, marked primary. UNCONDITIONAL on is_active and on unit_label being non-null: an
  -- inactive owner still has invoice history, and a roster row with no label is still a flat. Any
  -- WHERE narrowing this is how an owner ends up with zero flats and silently stops being billed.
  --
  -- The `not exists` guard is what makes the file re-runnable. Without it a second run gives every
  -- owner a duplicate flat, building_owner_flats_primary_idx rejects it, and — because the editor
  -- runs a file as one transaction — NOTHING applies.
  insert into public.building_owner_flats
    (id, building_id, owner_id, unit_label, flat_no, default_service_charge,
     is_primary, joined_at, is_active, created_at, updated_at)
  select gen_random_uuid(), o.building_id, o.owner_id, o.unit_label, o.flat_no,
         o.default_service_charge, true, o.joined_at, o.is_active, o.created_at, now()
    from public.building_owners o
   where not exists (
     select 1 from public.building_owner_flats f
      where f.owner_id = o.owner_id and f.building_id = o.building_id
   );

  -- ================================================================= 3. BACKFILL: THE ORPHANS
  -- An invoice can outlive its roster row: DELETE /owners/[id] detaches by deleting building_owners
  -- and KEEPING the invoices, on purpose. So on any building that has been running a while,
  -- building_service_invoices contains rows whose owner_id matches nothing in the roster. Those get
  -- no flat from step 2, so they would keep flat_id null forever — blocking SET NOT NULL in the
  -- finalize file, printing with no flat name, and sitting guarded by neither index.
  --
  -- They get an INACTIVE, NON-PRIMARY flat: enough to name and group their history, invisible to
  -- the generate-a-month enumeration (which filters is_active AND cross-checks the live roster),
  -- and it does not put a detached person back on anyone's roster.
  insert into public.building_owner_flats
    (id, building_id, owner_id, unit_label, flat_no, default_service_charge,
     is_primary, is_active, created_at, updated_at)
  select gen_random_uuid(), i.building_id, i.owner_id, null, null, 0, false, false, now(), now()
    from (select distinct building_id, owner_id from public.building_service_invoices) i
   where not exists (
     select 1 from public.building_owner_flats f
      where f.owner_id = i.owner_id and f.building_id = i.building_id
   );

  -- ================================================================= 4. THE INVOICE COLUMNS
  -- No DEFAULT on either, so neither ALTER rewrites the table.
  alter table public.building_service_invoices add column if not exists flat_id    uuid;
  alter table public.building_service_invoices add column if not exists flat_label text;

  update public.building_service_invoices i
     set flat_id = f.id
    from public.building_owner_flats f
   where f.owner_id = i.owner_id
     and f.building_id = i.building_id
     and i.flat_id is null;

  update public.building_service_invoices i
     set flat_label = f.unit_label
    from public.building_owner_flats f
   where f.id = i.flat_id
     and i.flat_label is null;

  -- ================================================================= 5. THE GUARD SPLIT
  -- The unique index is what makes "generate for this month" safe to press twice. Replacing it is
  -- the one genuinely consequential statement in this file, so it is done as a SPLIT rather than a
  -- swap — and the whole file is one transaction, so there is no instant at which a duplicate could
  -- slip in.
  --
  --   NEW ROWS (flat_id set, written only by the new code): guarded per FLAT per month. This is the
  --   rule the feature exists for — flat 3B settled while 4A is still owed.
  --
  --   OLD ROWS (flat_id null, written only by code deployed before this file): still guarded per
  --   OWNER per month, exactly as they were. That partial index is what lets this file run BEFORE
  --   the deploy with production completely unaffected, and it also covers the seconds during a
  --   rollout when old and new instances are both serving.
  --
  -- The flat guard is a plain unique index rather than a partial one on purpose: Postgres indexes
  -- are NULLS DISTINCT by default, so null-flat rows simply do not collide in it. Both of those
  -- facts have to hold for the split to work; neither is an accident.
  create unique index if not exists building_invoice_flat_month_idx
    on public.building_service_invoices (flat_id, billing_month);

  create unique index if not exists building_invoice_legacy_owner_month_idx
    on public.building_service_invoices (owner_id, billing_month)
    where flat_id is null;

  drop index if exists public.building_invoice_owner_month_idx;

  create index if not exists building_invoice_flat_idx
    on public.building_service_invoices (flat_id, created_at desc);

  -- The invoice's own owner_id STAYS, and stays not null. It is now a denormalisation of
  -- flat.owner_id, and it is load-bearing: the flat owner's own statement filters on it, the push
  -- notification is addressed by it, building_service_payments denormalises it, and
  -- lib/account-purge.ts deletes by it. Keeping the two in step is a server-side discipline — every
  -- write derives owner_id from the flat row it was handed — not a constraint: a CHECK cannot cross
  -- tables and a trigger is not worth it on a live money table.

  -- ================================================================= 6. PROVE IT
  select count(*) into v_roster   from public.building_owners;
  select count(*) into v_flats    from public.building_owner_flats;
  select count(*) into v_orphans  from public.building_owner_flats where not is_active and not is_primary;
  select count(*) into v_unlinked from public.building_service_invoices where flat_id is null;
  -- ⚠️ THE BACKFILL ABOVE DOES NOT CREATE PROPERTIES. Property creation lives in
  -- lib/building-flats.ts, so only flats added through the API get the rentable unit behind them —
  -- and a flat with no unit is INVISIBLE in the owner's dashboard, which lists properties and never
  -- consults this table. This count is how you see that; the original version of this file did not
  -- report it, and the gap went unnoticed until an owner asked where their other flat had gone.
  -- Fix it by running REPAIR_BUILDING_FLAT_PROPERTIES.sql.
  select count(*) into v_noprop
    from public.building_owner_flats
   where property_id is null and is_active and unit_label is not null;

  raise notice 'ADD_BUILDING_OWNER_FLATS: applied. roster=%, flats=% (of which % historical/detached), invoices still unlinked=% (must be 0), flats with no rentable unit=%.',
    v_roster, v_flats, v_orphans, v_unlinked, v_noprop;

  if v_unlinked > 0 then
    raise notice '  ^^ NOT ZERO. Do not run FINALIZE_BUILDING_FLAT_INVOICES.sql until it is. Investigate before deploying.';
  end if;

  if v_noprop > 0 then
    raise notice '  ^^ % flat(s) have no rentable unit and will not appear in their owner dashboard. Run REPAIR_BUILDING_FLAT_PROPERTIES.sql.', v_noprop;
  end if;
end $$;
