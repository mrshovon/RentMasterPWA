-- Public contact enquiries: let someone who has no account reach us from the pricing page.
-- Run once in the Supabase SQL editor (service role). Idempotent — safe to re-run.
-- Requires ADD_CONTACT_MESSAGES.sql.
--
-- ⚠️ RUN THIS BEFORE DEPLOYING the code that ships with it. POST /api/app/contact writes a row
-- with owner_id NULL; until this runs, every public enquiry fails with 23502 (not-null violation)
-- and the visitor sees a generic error on a form that looks like it should work.
--
-- WHY. `contact_messages.owner_id` was `uuid not null` because the only way to send an enquiry
-- was the "Contact us" button on the Whole Building plan card inside an owner's account
-- (ADD_CONTACT_MESSAGES.sql:13-14). The new public /plans page shows that same tier to people who
-- have not signed up — and "contact us" is its ONLY call to action, since the plan is priced
-- offline. Without a nullable owner_id that card is a dead end for exactly the audience it exists
-- to attract.
--
-- NULL means "not one of our owners", which is a fact worth being able to see: the admin Messages
-- queue already falls back to the row's own `name`/`email`/`phone` columns, which the public form
-- requires, so a null owner renders correctly with no change to that screen.
--
-- The column stays NOT a foreign key, as before — see the header of ADD_CONTACT_MESSAGES.sql.

do $$
begin
  if to_regclass('public.contact_messages') is null then
    raise notice 'ADD_PUBLIC_CONTACT: contact_messages does not exist — SKIPPED. Run ADD_CONTACT_MESSAGES.sql first, then re-run this file.';
    return;
  end if;

  alter table public.contact_messages alter column owner_id drop not null;

  raise notice 'ADD_PUBLIC_CONTACT: applied — contact_messages.owner_id is now nullable.';
end $$;

-- The owner index already exists and is unaffected: Postgres b-tree indexes store NULLs, and
-- every existing lookup is an equality match on a real uuid, which never matches NULL anyway.
