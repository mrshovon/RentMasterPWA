-- Payment submissions: an owner's manual bKash payment awaiting admin approval.
-- Run once in the Supabase SQL editor (service role). Idempotent.
--
-- Flow: an owner who wants a paid tier pays into the admin-configured bKash personal number/QR,
-- then submits the sender mobile number + transaction id + amount here (status 'pending'). A super
-- admin approves (-> the plan activates via a new subscription_history row) or rejects (with a
-- remarks note the owner sees). A PENDING row deliberately writes NO subscription_history row, so
-- the owner stays on their current plan until approval.
--
-- `provider` future-proofs for real gateways (bkash_gateway, sslcommerz, stripe): those would
-- write their own rows here (or bypass this table) without reworking the approval queue.
--
-- owner_id is intentionally NOT a foreign key, same rationale as support_tickets / contact_messages:
-- owners live in auth.users and a missing user_profiles stub must never make a payment un-writable.

create table if not exists public.payment_submissions (
  id            uuid primary key,
  payment_no    bigint generated always as identity,     -- human-facing reference, e.g. "#42"
  owner_id      uuid not null,                            -- auth.users.id of the paying owner
  owner_email   text,                                     -- snapshot of the email at submit time
  provider      text not null default 'manual_bkash'
                  check (provider in ('manual_bkash')),   -- extend as real gateways are added
  tier_id       text not null,                            -- subscription_tiers.id (text slug) being bought
  amount        numeric,                                  -- amount the owner says they paid
  sender_msisdn text,                                     -- mobile number the payment was sent FROM
  txn_id        text,                                     -- bKash transaction id
  status        text not null default 'pending'
                  check (status in ('pending', 'approved', 'rejected')),
  admin_notes   text,                                     -- rejection remarks; visible to the owner
  reviewed_by   uuid,                                     -- acting admin's auth.users.id
  reviewed_at   timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index if not exists payment_submissions_owner_idx   on public.payment_submissions (owner_id);
create index if not exists payment_submissions_status_idx  on public.payment_submissions (status);
create index if not exists payment_submissions_created_idx on public.payment_submissions (created_at desc);

-- Same posture as ENABLE_RLS.sql: RLS on with NO policies (deny-all to anon/authenticated) and the
-- default API grants revoked. The backend reaches this table with the service-role key, which
-- bypasses RLS entirely.
alter table public.payment_submissions enable row level security;
revoke all on public.payment_submissions from anon, authenticated;
