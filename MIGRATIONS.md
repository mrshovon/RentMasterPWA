# Migrations

There is no migration tool. The base schema was built by hand in the Supabase dashboard, and every
change since is a SQL file at this directory's root, pasted into the **Supabase SQL editor** by a human.
DDL cannot be run from the app — the service-role key reaches PostgREST, which does not do DDL.

**This file is the only record of what has actually been applied. Update it when you run something.**

The failure mode it exists to prevent: a SQL file gets written, the code that depends on it gets written
too, typecheck and build both pass — and the app only breaks at runtime against the real database. That
has now happened twice.

## Rules

- A new SQL file must be idempotent (`create ... if not exists`, `add column if not exists`, `do $$ ... end $$`
  guards) so it is safe to re-run.
- New tables must follow `ENABLE_RLS.sql`: `enable row level security` with **no policies**, plus
  `revoke all ... from anon, authenticated`. The backend uses the service-role key, which bypasses RLS.
- Ship the SQL file and the code that needs it together, then run the SQL **before** relying on it.
- The Supabase SQL editor runs a script as a single transaction — a failure part-way rolls back the
  *whole* file. Do not assume a script that errored applied "the earlier bits".

## Applied

| File | Status | What it does / what breaks without it |
|---|---|---|
| `ENABLE_RLS.sql` | ✅ applied 2026-07-12 | RLS on every table, zero policies, grants revoked from `anon`/`authenticated`. Without it the anon key reads all tables. Verified: anon key now 401s. |
| `ADD_WEBPUSH.sql` | ✅ applied | Adds `p256dh` / `auth` / `role` to `device_tokens`, unique on `token`. Without it web-push subscription registration fails. |
| `FIX_PUSH_AND_TENANT_MOVE.sql` | ✅ applied 2026-07-14 | Adds `tenants.owner_id` (+ backfill), makes `tenants.property_id` nullable, retypes `device_tokens.user_id` uuid→text and drops its FK + RLS policies. Without it `GET /api/admin/tenants` 500s (owner login is dead) and tenant push registration fails. **Originally aborted** on `0A000: cannot alter type of a column used in a policy definition` — fixed by adding step 0, which drops the dependent `device_tokens` policies first. |
| `ADD_SUPPORT_TICKETS.sql` | ✅ applied 2026-07-14 | Creates `support_tickets` (owner → system-admin tickets, `submitted → assigned → in_progress → done`, `assigned_to` / `finished_at`). Without it the owner Support tab and admin Tickets queue 404. |
| `ADD_TENANT_LOGIN_CONTROL.sql` | ✅ applied 2026-07-15 | Adds `tenants.allow_login_unassigned` (default `false`). Lets owners block an unassigned tenant from signing in, with a per-tenant override. Without it, tenant login and `GET /api/admin/tenants/me` 500 on the missing column. |
| `ADD_PASSWORD_RESET_HISTORY.sql` | ⏳ NOT YET APPLIED | Creates `password_reset_history` (append-only audit of owner password changes: `admin_reset` / `self_service_email` / `self_change`). Admin-only read via `/api/super-admin/password-resets`. Without it, the reset routes' audit writes fail (non-fatal) and the admin Reset-log tab 500s/empties. |
| `ADD_CONTACT_MESSAGES.sql` | ✅ applied | Creates `contact_messages` (owner "Contact us" enquiries from the custom plan card, `new → in_progress → resolved/archived`). Without it, the owner contact form POST and the admin Messages queue 404/500. ⚠️ Applied with `tier_id uuid`, which rejects the text tier slugs (`whole_building`) — see `ALTER_CONTACT_MESSAGES_TIER_ID_TEXT.sql`. The `.sql` file has since been corrected to `text` for fresh installs. |
| `ALTER_CONTACT_MESSAGES_TIER_ID_TEXT.sql` | ⏳ NOT YET APPLIED | Retypes `contact_messages.tier_id` uuid→text so tier slugs (`whole_building`, `free_tier`, …) can be stored. Without it the "Whole Building" Contact-us POST 500s with `invalid input syntax for type uuid: "whole_building"`. |
| `ADD_PAYMENT_SUBMISSIONS.sql` | ⏳ NOT YET APPLIED | Creates `payment_submissions` (owner manual bKash payments awaiting admin approval, `pending → approved/rejected`). On approval a `subscription_history` row activates the plan; a pending row writes none. Without it the owner payment POST and admin Payments queue 404/500. |
| `ADD_APP_SETTINGS.sql` | ⏳ NOT YET APPLIED | Creates `app_settings` (key/value singleton for `payment_config` + `default_signup_tier`). Without it the Payment Setup menu, the owner payment screen's QR, and the default-signup-tier setting have nowhere to read/write. (QR image reuses the existing public `RentMasterProDocs` bucket via `/api/admin/uploads` — no new bucket.) |
