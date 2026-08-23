-- System-generated login identifiers for building-tier accounts.
-- Run once in the Supabase SQL editor (service role). Idempotent — safe to re-run.
--
-- A building admin and the flat owners on their roster do not shop for this app; they are
-- enrolled into it by whoever runs their building. Asking each of them for a working email
-- address is friction at the moment we have the least of their attention, and most will give
-- an address they never read. So those accounts get an IDENTIFIER instead, derived from where
-- the person actually lives:
--
--     building admin   12a-678@bari360.com      house + last 3 digits of mobile
--     member owner     12a-3b-456@bari360.com   house + flat + last 3 digits of mobile
--
-- It is still just the email string — see lib/validate.ts. auth.users.email is already unique
-- and nothing in the codebase rewrites it, so there is no login_id column here and no second
-- source of truth. These two columns store the INPUTS an identifier was built from, never the
-- identifier itself.
--
-- WHY house_no IS NULLABLE, and why that is the whole migration story: a building with no
-- house number keeps the existing typed-email path, forever. That single null check is what
-- lets old and new accounts coexist without a backfill, and it means this file can be run
-- before or after the code ships — until an admin fills the number in, nothing changes.
--
-- NO NEW TABLES, so there is no RLS section below. That is not an oversight: both tables were
-- locked down in ADD_BUILDINGS.sql (RLS on, no policies, grants revoked) and adding a column
-- inherits all of it.

-- =====================================================================================
-- 1. The building's house number
-- =====================================================================================
-- The street/holding number, as a human writes it: "12/A", "৪৫", "House 7". It is normalised
-- down to an identifier component in code (lib/validate.ts loginToken), not here, because the
-- same normaliser has to run in the browser to preview the login before the account exists.
--
-- Deliberately NOT unique. House number "12" is genuinely not unique across a city, and a
-- global unique index would reject legitimate buildings. The uniqueness that actually matters
-- is on the finished address, and auth.users.email already enforces that.
alter table public.buildings
  add column if not exists house_no text;

-- =====================================================================================
-- 2. The roster owner's flat, normalised
-- =====================================================================================
-- unit_label already holds the pretty free text ("Flat 4B") that prints on statements. This
-- holds the token that went into the login ("4b"). One input in the UI, two derived columns:
-- one for reading, one for identity.
--
-- Also deliberately NOT unique per building. Two co-owners of the same flat — a couple, or an
-- inherited share — must both be able to sign in, and the identifier collision rule handles
-- that by appending "-2". A unique index here would refuse the second one outright.
alter table public.building_owners
  add column if not exists flat_no text;
