-- =====================================================================================
-- PAYMENT CLAIMS + PAY-TO DETAILS
--
-- Tenants (rent) and flat owners (service charge) can tell the payee HOW they paid before the
-- payee records real money. A claim is a MESSAGE, never a payment: it creates no money row, does
-- not change any balance, and the payee still records/confirms the actual receipt. Rent already
-- has a `sent` status; service charge deliberately does not (its CHECK allows only
-- unpaid/partial/paid), so the claim itself is what the flat-owner UI reads as "sent — awaiting
-- confirmation". No existing CHECK constraint is touched.
--
-- Pay-to details are where the payer sends money: an account reference, a Bangla QR image, free
-- instructions, and which of the four methods the payee accepts plus the preselected default.
-- Owner rent details live in auth user_metadata (the existing owner settings pattern); building
-- service-charge details live on the buildings row, beside its letterhead and signatory.
--
-- Idempotent: safe to run more than once. The Supabase SQL editor runs a file as one transaction,
-- so a failure rolls the whole thing back.
-- =====================================================================================

create table if not exists public.payment_claims (
  id             uuid primary key,
  source         text not null check (source in ('rent', 'service_charge')),
  ref_id         text not null,             -- billing_ledgers.id or building_service_invoices.id
  payer_id       text not null,             -- tenants.id, or a flat owner's auth uid
  payee_id       text not null,             -- the owner's or building admin's auth uid
  method         text not null check (method in ('cash', 'proxy', 'bank', 'p2p_qr')),
  reference      text,                       -- optional txn id, bank/QR only
  note           text,                       -- optional remarks, bank/QR only
  status         text not null default 'pending'
                   check (status in ('pending', 'confirmed', 'dismissed')),
  created_at     timestamptz not null default now(),
  resolved_at    timestamptz,
  resolved_by    text
);

-- One open claim per invoice. The partial index IS the dedupe: 'cancelled' rows are historical
-- and a later payment attempt must be allowed to create a fresh pending row.
create unique index if not exists payment_claims_one_open_per_invoice
  on public.payment_claims (source, ref_id)
  where status = 'pending';

create index if not exists payment_claims_payer_idx
  on public.payment_claims (payer_id, created_at desc);
create index if not exists payment_claims_payee_idx
  on public.payment_claims (payee_id, status, created_at desc);

alter table public.payment_claims enable row level security;
-- Deliberately NO policies: the service role bypasses RLS, and no browser may read or write these
-- rows directly. All access goes through /api/admin/payment-claims, scoped by middleware.
revoke all on public.payment_claims from anon, authenticated;

-- Building-side pay-to details. text[] so the accepted method list stays ordered and can be
-- validated in the route; default_method is what a payer sees preselected (they can change it).
alter table public.buildings
  add column if not exists service_charge_pay_to text,
  add column if not exists service_charge_qr_url text,
  add column if not exists service_charge_instructions text,
  add column if not exists service_charge_methods text[],
  add column if not exists service_charge_default_method text not null default 'p2p_qr';
