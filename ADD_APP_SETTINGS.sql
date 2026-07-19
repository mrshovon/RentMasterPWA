-- App settings: a tiny key/value singleton store for platform-wide admin config.
-- Run once in the Supabase SQL editor (service role). Idempotent.
--
-- Rows used so far:
--   payment_config       -- { provider, walletNumber, instructions, qrUrl } for the manual MFS payment screen
--   default_signup_tier  -- { tierId } given to newly self-signed-up owners (default: free)
--
-- There was no global settings table before (the only "settings" were per-owner, in auth
-- user_metadata). Everything here is app-wide and admin-managed via /api/super-admin/*.

create table if not exists public.app_settings (
  key         text primary key,
  value       jsonb not null default '{}'::jsonb,
  updated_at  timestamptz not null default now()
);

-- Same posture as ENABLE_RLS.sql: RLS on with NO policies (deny-all to anon/authenticated) and the
-- default API grants revoked. The backend reaches this table with the service-role key, which
-- bypasses RLS entirely.
alter table public.app_settings enable row level security;
revoke all on public.app_settings from anon, authenticated;

-- Note on the QR image: the Payment Setup menu uploads the bKash QR through the existing
-- storage upload route (/api/admin/uploads -> public "RentMasterProDocs" bucket, folder
-- "payments") and stores the returned public URL in app_settings.payment_config.qrUrl. No new
-- bucket is needed — that bucket already exists and is public.
