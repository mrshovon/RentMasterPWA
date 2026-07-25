-- Two unrelated nullable columns, in one file so there is one thing to paste.
-- Run once in the Supabase SQL editor (service role). Idempotent — safe to re-run.
-- Neither table has DDL in this repo (the base schema was made by hand), so these are plain
-- `add column if not exists` and nothing here scans or rewrites existing rows.

-- =====================================================================================
-- 1. tenants.nid_encrypted — an EDITABLE national ID
-- =====================================================================================
-- The NID used to be SHA-256 hashed into nid_hash at onboarding and then never read, shown or
-- verified by anything. That made it write-only: an owner could not see what was on file, could
-- not correct a typo, and the plaintext was gone forever. It is now stored encrypted (AES-256-GCM,
-- see lib/field-crypto.ts) and decrypted server-side for the OWNER only — never for the tenant.
--
-- Requires the NID_ENCRYPTION_KEY environment variable on the server. Without it, saving an NID
-- fails loudly rather than silently dropping what the owner typed.
alter table public.tenants
  add column if not exists nid_encrypted text;

-- nid_hash is left in place but is now LEGACY and unused. It is a one-way unsalted hash, so the
-- NIDs of tenants onboarded before this change cannot be recovered from it — those tenants show
-- an empty NID field until the owner re-enters the number. Dropping the column is safe whenever
-- you want to, but is deliberately not done here.

-- =====================================================================================
-- 2. properties.receipt_name — the name printed on that property's receipts
-- =====================================================================================
-- Receipts printed the owner's account name for every property. An owner managing a building
-- under a business or building name had no way to put it on the paper. Null (the default) keeps
-- the existing behaviour: fall back to the account name.
alter table public.properties
  add column if not exists receipt_name text;
