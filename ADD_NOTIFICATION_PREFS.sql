-- Per-account notification preferences. Run once in the Supabase SQL editor (service role). Idempotent.
--
-- Right now this holds one thing: which sound a person's notifications make.
--   'custom'  -> the Bari360 brand tone (android/app/src/main/res/raw/bari360_tone.mp3)
--   'default' -> whatever the device's own notification sound is
--   'off'     -> silent; the notification still arrives, it just makes no noise
--
-- Why a table and not user_metadata: user_metadata only exists for owners/admins (auth.users).
-- Tenants sign in with a tenant JWT and have no auth user, so a preference stored there could
-- never cover them. `device_tokens.user_id` already holds BOTH owner auth uids and tenant ids,
-- and this table is keyed the same way so lib/push-send.ts can join the two in one query.
--
-- user_id is `text` and deliberately NOT a foreign key. It references two different identity
-- spaces, and MIGRATIONS.md warns the base-schema primary keys are not uniformly uuid. A person
-- losing their ringtone preference is not worth an insert that can fail with 23503.

create table if not exists public.notification_prefs (
  user_id    text primary key,           -- owner auth uid OR tenant id (same space as device_tokens.user_id)
  sound      text not null default 'custom'
               check (sound in ('custom', 'default', 'off')),
  updated_at timestamptz not null default now()
);

-- Same posture as ENABLE_RLS.sql: RLS on with NO policies (deny-all to anon/authenticated) and the
-- default API grants revoked. The backend reaches this table with the service-role key, which
-- bypasses RLS entirely.
alter table public.notification_prefs enable row level security;
revoke all on public.notification_prefs from anon, authenticated;
