-- =====================================================================================
-- REDIRECTABLE IN-APP NOTICES
--
-- Push notifications already deep-link: app/sw.ts and lib/native-push.ts read `data.url` from
-- the push payload. The INBOX row did not — a notice card could not be tapped, and there was no
-- way for an admin to say "this notice opens Billing". These two columns close that gap.
--
-- `is_clickable` defaults to false, so every historic row stays exactly as it reads today; the
-- CHECK only constrains NEW writes. Destinations are validated in the application against a
-- fixed allow-list (lib/notice-targets.ts) rather than in the database, because the valid set is
-- a UI/tab vocabulary that changes when a dashboard gets a new tab.
--
-- Idempotent: safe to re-run. The Supabase SQL editor runs the file as one transaction.
-- =====================================================================================

alter table public.notices
  add column if not exists is_clickable boolean not null default false,
  add column if not exists action_url text;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'notices_action_present_check' and conrelid = 'public.notices'::regclass
  ) then
    alter table public.notices
      add constraint notices_action_present_check
      check (not is_clickable or action_url is not null)
      not valid;
  end if;
end $$;
