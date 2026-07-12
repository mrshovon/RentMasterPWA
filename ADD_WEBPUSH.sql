-- Web Push (VAPID) migration for the device_tokens table.
-- Run once in the Supabase SQL editor (service role). Idempotent.
--
-- The table was originally FCM-shaped ({user_id, token, device_type}). Web Push stores a
-- PushSubscription: the `token` column now holds the subscription ENDPOINT (already unique),
-- and we add the two encryption keys + a role so broadcasts can target tenants vs owners.

alter table public.device_tokens
  add column if not exists p256dh text,
  add column if not exists auth   text,
  add column if not exists role   text;   -- 'tenant' | 'owner' | 'admin'

-- Ensure the endpoint (stored in `token`) is unique so re-subscribing upserts cleanly.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'device_tokens_token_key'
  ) then
    alter table public.device_tokens add constraint device_tokens_token_key unique (token);
  end if;
end $$;

create index if not exists device_tokens_user_id_idx on public.device_tokens (user_id);
create index if not exists device_tokens_role_idx    on public.device_tokens (role);
