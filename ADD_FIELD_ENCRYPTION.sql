-- Encrypted-at-rest columns for the national ID and payment identifiers that were stored in the
-- clear. Run once in the Supabase SQL editor (service role). Idempotent.
--
-- Why it exists: tenants.nid_encrypted has been AES-256-GCM encrypted since
-- ADD_TENANT_NID_AND_RECEIPT_NAME.sql, but three equally sensitive fields were never given the
-- same treatment:
--   staff.nid_number                 -- a government ID, in plaintext, next to a photo and an ID scan
--   payment_submissions.sender_msisdn -- the mobile number a real payment came from
--   payment_submissions.txn_id        -- the mobile-money transaction id it came under
-- The last two together tie a person to a financial transaction, which is the pairing that makes
-- a leaked dump worth something. All three are ENCRYPTED rather than hashed because they have to
-- be read back: the owner confirms a staff NID, and an admin reconciles a payment by eye against
-- the bKash statement before approving it.
--
-- Safe to encrypt because none of these columns is ever queried. staff is indexed on owner_id and
-- property_id; payment_submissions on owner_id, status and created_at. There is no index, unique
-- constraint or search over any of the three. (This is the whole feasibility question: encryptField
-- is randomized — a fresh IV per call — so equality matching does not survive it. A future need to
-- search these wants a deterministic blind index, not a column read.)
--
-- The old plaintext columns are deliberately KEPT and left in place. The read paths fall back to
-- them, so the app works correctly before, during and after the backfill, and a half-finished
-- migration is never destructive. Drop them only once the backfill below reports zero rows left.

alter table public.staff
  add column if not exists nid_encrypted text;  -- v1:<iv>:<tag>:<ct>, see lib/field-crypto.ts

alter table public.payment_submissions
  add column if not exists sender_msisdn_encrypted text,
  add column if not exists txn_id_encrypted        text;

-- Rows that still hold plaintext, i.e. the backfill queue. Encryption happens in the application
-- (Postgres has no access to FIELD_ENCRYPTION_KEY), so this migration cannot convert them itself.
-- Run scripts/backfill-encryption.mjs to do it, then re-run these to confirm both return 0.
--
--   select count(*) from public.staff
--     where nid_number is not null and nid_number <> '' and nid_encrypted is null;
--   select count(*) from public.payment_submissions
--     where txn_id is not null and txn_id <> '' and txn_id_encrypted is null;

-- app_settings.payment_config.walletNumber is encrypted too, but needs nothing here: it is a JSON
-- key in a singleton row, getPaymentConfig() falls back to the plaintext, and the next save from
-- admin -> Payment setup writes walletNumberEnc and clears it. Re-save it once to migrate.

-- Legacy one-way hash of a tenant's national ID. Nothing has read it since the column became
-- nid_encrypted — lib/tenants.ts destructures it purely to throw it away. It is an unsalted hash
-- of a low-entropy government identifier (Bangladeshi NIDs are 10, 13 or 17 digits, and the
-- keyspace is far narrower in practice given the date-of-birth prefix), so it is effectively
-- plaintext to anyone holding a dump. Dead weight that leaks: drop it.
alter table public.tenants
  drop column if exists nid_hash;

-- No new indexes. These columns are written and displayed, never filtered or sorted on — adding an
-- index over ciphertext would cost writes and buy nothing.

-- Same posture as ENABLE_RLS.sql: RLS on with NO policies (deny-all to anon/authenticated) and the
-- default API grants revoked. The backend reaches these tables with the service-role key, which
-- bypasses RLS entirely. Both tables already carry this from their own migrations; repeated here
-- because it is idempotent and this file must not be the one that leaves a table exposed.
alter table public.staff enable row level security;
revoke all on public.staff from anon, authenticated;

alter table public.payment_submissions enable row level security;
revoke all on public.payment_submissions from anon, authenticated;
