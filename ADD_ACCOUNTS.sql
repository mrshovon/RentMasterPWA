-- Accounts module: owners keep a lightweight bookkeeping ledger — the "wallets" they hold money in
-- (cash in hand, bank, MFS like bKash/Nagad), the income and expense entries against them, and
-- transfers of money between two of their own accounts.
-- Run once in the Supabase SQL editor (service role). Idempotent — safe to re-run.
--
-- Accounts is a COMMERCIAL feature, not a free one — the SAME gating as Staff (see ADD_STAFF.sql):
--   * the Whole Building tier (billing_interval = 'custom') includes it — see accounts_included below;
--   * every other plan treats it as a paid add-on the super-admin grants per owner via owner_addons
--     (addon_key = 'accounts'). owner_addons already exists from ADD_STAFF.sql — reused, not recreated.
--   * The admin grant is absolute: it works on any tier, free included (trials, special cases).
--
-- Two automations write here (best-effort, from the app):
--   * marking an invoice Paid  -> an 'income'  row (source = 'billing',      source_ref = ledger id);
--   * logging a staff salary   -> an 'expense' row (source = 'staff_salary', source_ref = payment id).
-- Both post to the owner's DEFAULT account (accounts.is_default) and reverse when undone. The partial
-- unique index on (source, source_ref) makes them idempotent — re-firing can never double-book.
--
-- Income/expense TOTALS are a trivial sum of account_transactions. Transfers live in their own table
-- so they are automatically NEUTRAL to income/expense and net to zero on the total-balance card.
--
-- owner_id is intentionally NOT a foreign key (same rationale as staff / reminders / contact_messages:
-- a missing user_profiles stub must never make a record un-writable). Money is numeric(14, 2).
-- property_id is TEXT ("UNIT-1234", see generateUniqueUnitId in the properties route), NOT uuid.

-- =====================================================================================
-- 1. ACCOUNTS (the wallets)
-- =====================================================================================
create table if not exists public.accounts (
  id              uuid primary key,
  account_no      bigint generated always as identity,   -- human-facing reference, e.g. "#3"
  owner_id        uuid not null,                          -- auth.users.id of the owner
  name            text not null,                          -- "City Bank", "bKash personal", "Cash box"
  type            text not null default 'cash'
                    check (type in ('cash', 'bank', 'mfs', 'other')),
  opening_balance numeric(14, 2) not null default 0,      -- balance on the day the owner starts tracking
  is_default      boolean not null default false,         -- the target for auto income/expense entries
  is_active       boolean not null default true,          -- soft "closed" without losing history
  note            text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index if not exists accounts_owner_idx on public.accounts (owner_id);
-- At most one default account per owner. Partial unique so any number of non-default rows are fine.
create unique index if not exists accounts_one_default_idx
  on public.accounts (owner_id) where is_default;

-- =====================================================================================
-- 2. ACCOUNT TRANSACTIONS (income & expense)
-- =====================================================================================
create table if not exists public.account_transactions (
  id           uuid primary key,
  txn_no       bigint generated always as identity,
  owner_id     uuid not null,                             -- denormalised so ownership is enforced here
  account_id   uuid not null references public.accounts (id) on delete cascade,
  property_id  text references public.properties (id) on delete set null,   -- optional, text PK
  direction    text not null check (direction in ('income', 'expense')),
  amount       numeric(14, 2) not null check (amount > 0),
  category     text,                                      -- Rent / Salary / Utility / … (+ custom)
  txn_date     date not null,
  note         text,
  -- Automation provenance so auto-created rows can be traced, deduped and reversed.
  source       text not null default 'manual'
                 check (source in ('manual', 'billing', 'staff_salary')),
  source_ref   text,                                      -- billing_ledgers.id | staff_payments.id
  created_at   timestamptz not null default now()
);

create index if not exists account_txn_owner_idx    on public.account_transactions (owner_id, txn_date desc);
create index if not exists account_txn_account_idx  on public.account_transactions (account_id);
create index if not exists account_txn_property_idx on public.account_transactions (property_id);
-- One auto-entry per (invoice | salary payment). Manual rows are exempt (source = 'manual'), so an
-- owner can record as many manual entries as they like. bookAutoTransaction stays idempotent by
-- deleting any prior auto-row before inserting; this index also guards against a double-fire race.
create unique index if not exists account_txn_source_ref_idx
  on public.account_transactions (source, source_ref) where source <> 'manual';

-- =====================================================================================
-- 3. ACCOUNT TRANSFERS (money moved between two of the owner's accounts)
-- =====================================================================================
-- Kept in its own table (not account_transactions) so income/expense totals stay a plain sum of
-- account_transactions and a transfer never counts as either. Per-account balance folds these in:
--   balance = opening_balance + Σ income − Σ expense − Σ transfers_out + Σ transfers_in.
create table if not exists public.account_transfers (
  id               uuid primary key,
  transfer_no      bigint generated always as identity,
  owner_id         uuid not null,
  from_account_id  uuid not null references public.accounts (id) on delete cascade,
  to_account_id    uuid not null references public.accounts (id) on delete cascade,
  amount           numeric(14, 2) not null check (amount > 0),
  txn_date         date not null,
  note             text,
  created_at       timestamptz not null default now(),
  check (from_account_id <> to_account_id)                -- can't transfer to the same account
);

create index if not exists account_transfers_owner_idx on public.account_transfers (owner_id);

-- =====================================================================================
-- 4. WHICH PLANS INCLUDE ACCOUNTS
-- =====================================================================================
-- A column rather than a hardcoded tier name, so "which plans include Accounts" stays editable from
-- the admin console instead of requiring a code change (mirrors subscription_tiers.staff_included).
alter table public.subscription_tiers
  add column if not exists accounts_included boolean not null default false;

-- The Whole Building / enterprise ("contact us") tiers include it out of the box.
update public.subscription_tiers set accounts_included = true where billing_interval = 'custom';

-- =====================================================================================
-- 5. RLS
-- =====================================================================================
-- Same posture as ENABLE_RLS.sql / ADD_STAFF.sql: RLS on with NO policies (deny-all to anon and
-- authenticated) and the default API grants revoked. The backend reaches these tables with the
-- service-role key, which bypasses RLS entirely.
alter table public.accounts             enable row level security;
alter table public.account_transactions enable row level security;
alter table public.account_transfers    enable row level security;

revoke all on public.accounts             from anon, authenticated;
revoke all on public.account_transactions from anon, authenticated;
revoke all on public.account_transfers    from anon, authenticated;
