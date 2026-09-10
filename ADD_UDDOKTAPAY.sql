-- UddoktaPay (Paymently) gateway support.
-- Run once in the Supabase SQL editor (service role). Idempotent — safe to re-run.
--
-- ⚠️ RUN THIS BEFORE DEPLOYING the code that ships with it. The checkout route inserts
-- `provider = 'uddoktapay'`, which the existing CHECK constraint rejects, so without this file
-- every online payment fails at the first INSERT with a 23514 and the owner is charged nothing —
-- annoying rather than dangerous, but there is no reason to ship it that way.
--
-- WHAT THIS ADDS
--   1. `provider` accepts 'uddoktapay' (the column was always meant to carry a gateway —
--      ADD_PAYMENT_SUBMISSIONS.sql:11 says so — but the CHECK only ever allowed one value).
--   2. `status` accepts 'refunded'. A refund is not a rejection: a rejected payment never bought
--      anything, a refunded one did and was given back. Collapsing them would make the Payments
--      queue lie about what happened.
--   3. The gateway's own identifiers on payment_submissions.
--   4. A UNIQUE index on the gateway invoice id — the idempotency key for the whole feature.
--   5. The same invoice id + unique index on building_plan_payments.
--
-- ⭐ WHY gateway_invoice_id IS PLAINTEXT WHEN txn_id RIGHT BESIDE IT IS ENCRYPTED
--   lib/payments/submissions.ts:16-19 spells out the rule: encryptField is randomized-IV, so two
--   encryptions of the same string differ and equality does not survive it. An encrypted column
--   therefore CANNOT carry a unique index, and a unique index is the entire mechanism that stops a
--   duplicate webhook and a page reload from both activating a plan. So this column stays readable.
--   That is an acceptable trade: an UddoktaPay invoice id is an opaque reference to a payment on
--   someone else's system, not a mobile number tied to a person. sender_msisdn and txn_id keep
--   their encryption untouched.
--
-- The building half is wrapped in a to_regclass guard. MIGRATIONS.md:75 lists ADD_BUILDING_PLANS
-- as pending (it is stale — the tables were confirmed present on 2026-09-10), but the SQL editor
-- runs a file as ONE transaction, so a bare 42P01 against a missing table would apply *nothing at
-- all* — precisely how ADD_PLAN_TENURE.sql failed its first attempt (MIGRATIONS.md:56).

-- ==================================================================== 1. payment_submissions

-- The CHECK constraints were declared inline, so their names are Postgres-generated defaults.
-- Rather than guess at those names, find them by what they contain. A re-run finds nothing and
-- does nothing.
do $$
declare c record;
begin
  for c in
    select conname
      from pg_constraint
     where conrelid = 'public.payment_submissions'::regclass
       and contype  = 'c'
       and pg_get_constraintdef(oid) ilike '%manual_bkash%'
  loop
    execute format('alter table public.payment_submissions drop constraint %I', c.conname);
  end loop;

  for c in
    select conname
      from pg_constraint
     where conrelid = 'public.payment_submissions'::regclass
       and contype  = 'c'
       and pg_get_constraintdef(oid) ilike '%rejected%'
  loop
    execute format('alter table public.payment_submissions drop constraint %I', c.conname);
  end loop;
end $$;

alter table public.payment_submissions
  add constraint payment_submissions_provider_check
  check (provider in ('manual_bkash', 'uddoktapay'));

alter table public.payment_submissions
  add constraint payment_submissions_status_check
  check (status in ('pending', 'approved', 'rejected', 'refunded'));

alter table public.payment_submissions
  -- The UddoktaPay invoice id. Set by the fulfilment claim, never at charge time — see the
  -- unique index below for why that ordering is the whole point.
  add column if not exists gateway_invoice_id     text,
  -- Everything the Refund API needs, captured at fulfilment because it cannot be re-derived
  -- later: POST /refund-payment wants transaction_id + payment_method + amount + product_name,
  -- NOT the invoice id (verified against the UddoktaPay reference, 2026-09-10).
  add column if not exists gateway_txn_id         text,
  add column if not exists gateway_payment_method text,
  add column if not exists refunded_at            timestamptz,
  add column if not exists refund_reason          text;

-- ⭐ THE IDEMPOTENCY KEY.
-- Fulfilment claims a row with `update … set gateway_invoice_id = $1 where id = $2 and
-- gateway_invoice_id is null`. The redirect verification and the webhook race each other by
-- design — whichever arrives first claims it, the other updates zero rows and returns early.
-- Partial (`where … is not null`) so the many manual_bkash rows, which have no gateway invoice,
-- are not all fighting over a single NULL.
create unique index if not exists payment_submissions_gateway_invoice_idx
  on public.payment_submissions (gateway_invoice_id)
  where gateway_invoice_id is not null;

-- ==================================================================== 2. building_plan_payments

do $$
begin
  if to_regclass('public.building_plan_payments') is null then
    raise notice 'ADD_UDDOKTAPAY: building_plan_payments does not exist — building half SKIPPED. Run ADD_BUILDING_PLANS.sql, then re-run this file. The owner-subscription half above applied fine.';
    return;
  end if;

  -- Same column, same job, same reasoning as above. `method` already permits 'card'
  -- (ADD_BUILDING_PLANS.sql), so nothing there needs widening.
  alter table public.building_plan_payments
    add column if not exists gateway_invoice_id text;

  create unique index if not exists building_plan_payments_gateway_invoice_idx
    on public.building_plan_payments (gateway_invoice_id)
    where gateway_invoice_id is not null;
end $$;
