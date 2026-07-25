-- ADD_BILLING_PAID_AT.sql
-- Records WHEN a rent invoice was actually paid, so receipts can print the real payment date
-- and decide "LATE" honestly.
--
-- Why this file exists: the code has referenced billing_ledgers.paid_at since receipts landed,
-- but no migration file was ever written for it (the column was added by hand, or never at all).
-- This makes it explicit and re-runnable.
--
-- Without it: PATCH /api/admin/billing/[id] logs "paid_at not updated", every receipt falls back
-- to today's date, and a back-dated invoice is stamped LATE even when the tenant paid on time.

alter table public.billing_ledgers
  add column if not exists paid_at timestamptz;

-- The owner picks the date in the UI; it is stored at 12:00 UTC so the calendar day never shifts
-- between the server and a Bangladesh (UTC+6) reader.

-- Optional backfill. Invoices already marked paid have no payment date, so their receipts show
-- today's date and never flag late. created_at is the closest honest approximation — uncomment
-- only if you want those historical receipts to stop drifting. Owners can also just correct
-- individual dates from the Billing tab.
--
-- update public.billing_ledgers
--    set paid_at = created_at
--  where payment_status = 'paid'
--    and paid_at is null;
