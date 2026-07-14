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
