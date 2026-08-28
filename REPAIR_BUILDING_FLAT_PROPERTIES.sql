-- Repair: give every pre-existing building flat the rentable unit it should always have had.
-- Run once in the Supabase SQL editor (service role). Idempotent — safe to re-run.
-- Requires ADD_BUILDING_OWNER_FLATS.sql.
--
-- THE BUG THIS FIXES
--   ADD_BUILDING_OWNER_FLATS.sql created a building_owner_flats row for every existing roster entry
--   but never created the `properties` row behind it — both of its backfill passes omit property_id
--   entirely, because property creation lives in lib/building-flats.ts, not in the SQL. Only flats
--   added through the API AFTER that deploy got a unit.
--
--   The owner dashboard lists properties with one filter — properties.owner_id = caller
--   (app/api/admin/properties/route.ts) — and never consults building_owner_flats. So a flat with no
--   property CANNOT appear, and nothing errors: it is a pure silent absence. An owner holding flats
--   3 and 5, where 3 predates the feature, sees only 5. Flat 3 is billed on their service-charge
--   statement but is not a unit they can put a tenant in, raise rent against, or print history for.
--
--   Service-charge billing itself was never affected: building_service_invoices keys on flat_id,
--   never on property_id. Nothing was lost — the unit simply was not created.
--
-- WHICH FLATS THIS TOUCHES, AND WHICH IT DELIBERATELY DOES NOT
--   Only `property_id is null AND is_active AND unit_label is not null`.
--
--   That last pair matters. ADD_BUILDING_OWNER_FLATS.sql's SECOND backfill pass deliberately created
--   dead rows for DETACHED owners — invoices can outlive a roster row, so those owner_ids got an
--   inactive, non-primary, label-less flat purely so their history could be grouped. Creating
--   properties for those would hand units back to people who were removed from the building on
--   purpose, and their owner_id may no longer exist in auth.users at all.
--
-- ADOPT BEFORE CREATING
--   An owner who noticed the gap and made their own "Flat 3" unit must not end up with two. Each
--   flat first looks for an existing property of theirs with a matching flat_no that no other flat
--   has claimed, and links that. Only when none is found is a new one created. This is also what
--   makes a second run of this file a no-op even if the first run half-completed.
--
-- WHY user_profiles IS UPSERTED FIRST
--   properties.owner_id has a foreign key to user_profiles.id — the create-owner route upserts a
--   profile before it can create any property for exactly this reason. An owner provisioned before
--   that upsert existed may have no profile row, and the insert would fail with 23503.
--
-- WHY EACH FLAT IS ITS OWN exception BLOCK
--   The SQL editor runs a file as ONE transaction. Without a per-row catch, one bad flat — a deleted
--   auth user, a constraint nobody remembered — would roll back every good repair and report only
--   that "something failed". Per-row, a failure is counted and named and the rest still land.
--
-- VERIFICATION IS BEHAVIOURAL, NOT A COLUMN PROBE. This file changes no schema, so — exactly like
-- FIX_DEVICE_TOKEN_TRANSPORT.sql — you cannot tell it ran by looking at the table definition. The
-- closing notice is the acceptance test: `flats still unlinked` must be 0.

do $$
declare
  r          record;
  v_pid      text;
  v_created  int := 0;
  v_adopted  int := 0;
  v_failed   int := 0;
  v_left     bigint;
  v_tries    int;
begin
  if to_regclass('public.building_owner_flats') is null then
    raise notice 'REPAIR_BUILDING_FLAT_PROPERTIES: building_owner_flats missing — SKIPPED. Run ADD_BUILDING_OWNER_FLATS.sql first.';
    return;
  end if;

  for r in
    select f.id          as flat_id,
           f.owner_id    as owner_id,
           f.unit_label  as unit_label,
           b.name        as b_name,
           b.address     as b_address,
           b.city        as b_city
      from public.building_owner_flats f
      join public.buildings b on b.id = f.building_id
     where f.property_id is null
       and f.is_active
       and f.unit_label is not null
     order by f.created_at
  loop
    begin
      -- The FK target. `do nothing` because an existing profile is already correct — this is a
      -- repair, not a place to overwrite someone's name.
      insert into public.user_profiles (id, name, phone, role)
      select u.id,
             coalesce(nullif(u.raw_user_meta_data ->> 'name', ''), 'Owner'),
             coalesce(u.raw_user_meta_data ->> 'phone', ''),
             'owner'
        from auth.users u
       where u.id = r.owner_id
      on conflict (id) do nothing;

      -- 1. Adopt: their own unit, same flat number, not already claimed by another flat.
      select p.id
        into v_pid
        from public.properties p
       where p.owner_id = r.owner_id
         and lower(btrim(coalesce(p.flat_no, ''))) = lower(btrim(r.unit_label))
         and not exists (
           select 1 from public.building_owner_flats f2 where f2.property_id = p.id
         )
       order by p.created_at
       limit 1;

      if v_pid is null then
        -- 2. Create. The id format matches generateUniqueUnitId() in lib/properties.ts — UNIT-####,
        -- human-facing, text. Retry on collision, then fall back to a timestamp tail exactly as the
        -- app does, because a unit the owner cannot have is worse than an id that is not pretty.
        v_tries := 0;
        loop
          v_pid := 'UNIT-' || lpad((1000 + floor(random() * 9000))::int::text, 4, '0');
          exit when not exists (select 1 from public.properties p where p.id = v_pid);
          v_tries := v_tries + 1;
          if v_tries > 20 then
            v_pid := 'UNIT-' || right(extract(epoch from clock_timestamp())::bigint::text, 6);
            exit;
          end if;
        end loop;

        -- The same eight columns lib/properties.ts writes, so a repaired flat is indistinguishable
        -- from one created through the API. created_at is left to its default.
        insert into public.properties
          (id, owner_id, name, address, flat_no, receipt_name, owner_phone, is_vacant)
        values (
          v_pid,
          r.owner_id,
          coalesce(nullif(btrim(r.b_name), ''), 'Building'),
          coalesce(concat_ws(', ', nullif(btrim(r.b_address), ''), nullif(btrim(r.b_city), '')), ''),
          r.unit_label,
          null,
          (select u.raw_user_meta_data ->> 'phone' from auth.users u where u.id = r.owner_id),
          true
        );
        v_created := v_created + 1;
      else
        v_adopted := v_adopted + 1;
      end if;

      update public.building_owner_flats
         set property_id = v_pid, updated_at = now()
       where id = r.flat_id;

    exception when others then
      v_failed := v_failed + 1;
      raise notice '  ✗ flat % (%): %', r.flat_id, r.unit_label, sqlerrm;
    end;
  end loop;

  select count(*)
    into v_left
    from public.building_owner_flats
   where property_id is null and is_active and unit_label is not null;

  raise notice 'REPAIR_BUILDING_FLAT_PROPERTIES: % unit(s) created, % adopted, % failed. Flats still unlinked = % (must be 0).',
    v_created, v_adopted, v_failed, v_left;

  if v_left > 0 then
    raise notice '  ^^ NOT ZERO. The lines above name each one. Fix and re-run — this file is safe to run again.';
  end if;
end $$;
