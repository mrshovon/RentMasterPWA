import { supabaseAdminEngine } from './supabase-server';

// =====================================================================================
// 🧨 ACCOUNT PURGE — delete a person and everything about them, except the money.
//
// Extracted from app/api/super-admin/owners/[id]/route.ts so it can run more than once in a
// single request: deleting a building admin may now take every flat owner on its roster with it,
// and duplicating a forty-step cascade to do that is how the two copies drift apart.
//
// ⚠️ THE RULE THIS FILE EXISTS TO ENFORCE: almost none of these columns is a foreign key.
// Every uid column in this schema is a plain uuid by standing decision (ADD_BUILDINGS.sql:17-21,
// ADD_STAFF.sql, ADD_PAYMENT_SUBMISSIONS.sql:13-14) because the one FK that does exist —
// tenants/properties.owner_id -> user_profiles(id), NO ACTION — is what used to make
// auth.admin.deleteUser() abort with "Database error deleting user" for any owner with data.
// So THE STEP LIST BELOW IS THE ONLY THING KEEPING THE DATABASE CONSISTENT. A new table with an
// owner_id or user_id column must be added to it, or its rows outlive the account forever.
//
// Order matters: children before parents, and the auth user (which cascades into user_profiles)
// dead last, in the caller.
// =====================================================================================

// "This table/column isn't in the schema" — an optional module whose migration was never run.
// Nothing to delete, so skipping is correct.
//
// PGRST205/PGRST204 are what actually come back: supabase-js talks to PostgREST, which resolves
// names against its own schema cache and answers with its own codes rather than Postgres's
// 42P01/42703. Both sets are listed because only the PGRST ones are observed in practice, and
// missing either would turn "module not installed" into a hard delete failure.
export const MISSING_SCHEMA_CODES = ['PGRST205', 'PGRST204', '42P01', '42703'];

interface PurgeStep { table: string; column: string; values: string[] }

/**
 * Delete `table` rows whose `column` is in `values`. Returns the step outcome instead of throwing
 * so the caller can report exactly which table failed.
 */
async function purge({ table, column, values }: PurgeStep): Promise<{ skipped: boolean; error?: string }> {
  if (!values.length) return { skipped: true };
  const { error } = await supabaseAdminEngine.from(table).delete().in(column, values);
  if (!error) return { skipped: false };
  if (MISSING_SCHEMA_CODES.includes(error.code || '')) {
    console.warn(`[account-purge] skipping ${table}.${column} — not in the schema (${error.code}). Unapplied migration?`);
    return { skipped: true };
  }
  return { skipped: false, error: `${table}.${column}: ${error.message}` };
}

/**
 * Null a uid column on rows that belong to OTHER people, rather than deleting them.
 *
 * The preserved tables below now live forever, so a deleted *administrator's* uid would dangle on
 * every payment they ever approved and every password they ever reset — rows belonging to owners
 * who are still here. An UPDATE keeps the audit row and loses only the pointer; these columns are
 * already nullable and already read as "nobody" (a null `recorded_by` is how an auto-accepted
 * payment claim is recorded — ADD_BUILDING_PLANS.sql:160-162).
 *
 * Failures are logged and swallowed: a dangling reviewer uid is untidy, not a reason to abandon a
 * deletion that has already happened.
 */
async function detachActor(table: string, column: string, uid: string): Promise<void> {
  const { error } = await supabaseAdminEngine.from(table).update({ [column]: null }).eq(column, uid);
  if (error && !MISSING_SCHEMA_CODES.includes(error.code || '')) {
    console.warn(`[account-purge] could not detach ${table}.${column}: ${error.message}`);
  }
}

export interface PurgeResult {
  ok: boolean;
  /** Present only when ok is false — the table.column that refused, ready to show an admin. */
  error?: string;
  removed: { properties: number; tenants: number; invoices: number };
}

/**
 * Remove one account's data. Does NOT delete the auth user — the caller does that last, so a
 * failure here leaves the login alive and the whole thing retryable.
 *
 * Safe to call for an ordinary owner, a building admin or a flat owner: every step is keyed on
 * ids this account actually owns, so the ones that do not apply match nothing.
 */
export async function purgeOwnerAccount(id: string): Promise<PurgeResult> {
  const empty = { properties: 0, tenants: 0, invoices: 0 };

  // --- Collect the id sets the child tables are keyed on -------------------------------
  const { data: propRows, error: propErr } = await supabaseAdminEngine
    .from('properties').select('id').eq('owner_id', id);
  if (propErr) return { ok: false, error: `properties: ${propErr.message}`, removed: empty };
  const propertyIds = (propRows || []).map((p: { id: string }) => String(p.id));

  const { data: tenantRows, error: tenantErr } = await supabaseAdminEngine
    .from('tenants').select('id').eq('owner_id', id);
  if (tenantErr) return { ok: false, error: `tenants: ${tenantErr.message}`, removed: empty };
  const tenantIds = (tenantRows || []).map((t: { id: string }) => String(t.id));

  // billing_payments hangs off the ledger, not the owner.
  let ledgerIds: string[] = [];
  const { data: ledgerRows, error: ledgerErr } = await supabaseAdminEngine
    .from('billing_ledgers').select('id').eq('created_by_owner', id);
  if (ledgerErr && !MISSING_SCHEMA_CODES.includes(ledgerErr.code || '')) {
    return { ok: false, error: `billing_ledgers: ${ledgerErr.message}`, removed: empty };
  }
  if (ledgerRows) ledgerIds = ledgerRows.map((l: { id: string }) => String(l.id));

  const owned = [id];
  // Both an owner uid and a tenants.id can appear in the text-keyed tables below.
  const ownedAndTenants = [...owned, ...tenantIds];
  const removed = { properties: propertyIds.length, tenants: tenantIds.length, invoices: ledgerIds.length };

  // --- The cascade, children first -----------------------------------------------------
  const steps: PurgeStep[] = [
    // Money BETWEEN the owner and their tenants. Theirs, not ours — it goes.
    { table: 'billing_payments',           column: 'ledger_id',        values: ledgerIds },
    { table: 'billing_ledgers',            column: 'created_by_owner', values: owned },
    { table: 'account_transactions',       column: 'owner_id',         values: owned },
    { table: 'account_transfers',          column: 'owner_id',         values: owned },
    { table: 'accounts',                   column: 'owner_id',         values: owned },
    // Staff module.
    { table: 'staff_payments',             column: 'owner_id',         values: owned },
    { table: 'staff',                      column: 'owner_id',         values: owned },
    // Per-tenant and per-property records.
    { table: 'reminders',                  column: 'owner_id',         values: owned },
    { table: 'documents',                  column: 'tenant_id',        values: tenantIds },
    { table: 'rent_revision_archives',     column: 'tenant_id',        values: tenantIds },
    { table: 'service_charge_breakdowns',  column: 'property_id',      values: propertyIds },
    { table: 'property_occupancy_history', column: 'property_id',      values: propertyIds },
    { table: 'maintenance_logs',           column: 'property_id',      values: propertyIds },
    // Notices: written by them, addressed to them, or addressed to one of their tenants.
    { table: 'notices',                    column: 'sender_id',        values: owned },
    { table: 'notices',                    column: 'target_owner_id',  values: owned },
    { table: 'notices',                    column: 'target_tenant_id', values: tenantIds },
    // Push endpoints are keyed by text user_id holding either an owner uid or a tenant id.
    { table: 'device_tokens',              column: 'user_id',          values: ownedAndTenants },
    // Now the parents.
    { table: 'tenants',                    column: 'owner_id',         values: owned },
    { table: 'properties',                 column: 'owner_id',         values: owned },
    // Account-level records.
    { table: 'owner_addons',               column: 'owner_id',         values: owned },

    // The six tables the cascade used to MISS. None of them is a foreign key, so each one
    // silently orphaned a row against a dead uuid — a diagnostic trail, a notification
    // preference, a presence heartbeat for a person who no longer exists. `purge()` skips a table
    // whose migration has not run, so these are safe ahead of ADD_APP_LOGS /
    // ADD_NOTIFICATION_PREFS / ADD_PLAN_EVENTS. Their user_id columns are TEXT (they hold either
    // an auth uid or a tenants.id), which .in() handles the same way.
    { table: 'app_logs',                   column: 'user_id',          values: ownedAndTenants },
    { table: 'notification_prefs',         column: 'user_id',          values: ownedAndTenants },
    { table: 'user_presence',              column: 'user_id',          values: ownedAndTenants },
    { table: 'welcome_dispatch',           column: 'user_id',          values: owned },
    { table: 'plan_events',                column: 'owner_id',         values: owned },
    { table: 'building_plan_events',       column: 'admin_id',         values: owned },

    // Whole Building. Children first: payments hang off invoices, invoices off the roster/owner,
    // and the building is deleted last.
    { table: 'building_service_payments',  column: 'owner_id',         values: owned },
    { table: 'building_service_invoices',  column: 'owner_id',         values: owned },
    // Before building_owners: a flat row outliving the account it belongs to is invisible to
    // every screen and would keep the person on a building's billing enumeration forever.
    { table: 'building_owner_flats',       column: 'owner_id',         values: owned },
    { table: 'building_owners',            column: 'owner_id',         values: owned },
    // The config lists, notices, roster and service-charge rows still hanging off the building go
    // with it via its own `on delete cascade`. building_plan_invoices NO LONGER DOES — see
    // ADD_DELETION_AUDIT.sql — which is the entire point of that migration.
    { table: 'buildings',                  column: 'admin_id',         values: owned },
    { table: 'user_profiles',              column: 'id',               values: owned },
  ];

  // =====================================================================================
  // ⛔ DELIBERATELY NOT IN THE LIST ABOVE — kept for financial audit.
  //
  //   payment_submissions      the owner's manual bKash payments TO US, and the approve/reject
  //                            decision behind each. Already snapshots owner_email, so the row
  //                            still names its payer once the auth user is gone.
  //   subscription_history     which plan was activated and when. Without it a preserved payment
  //                            is unverifiable — it is the only link between money received and
  //                            the entitlement it bought.
  //   support_tickets          }  the correspondence around a disputed or refunded charge. An
  //   contact_messages         }  audit that cannot see what was said about a payment is half an
  //   password_reset_history   }  audit; the last is also the account-takeover trail.
  //   terms_acceptances        never purged before this change either, and still not: it is the
  //                            consent evidence for the payments being kept.
  //   building_plan_*          preserved by DROPPING a foreign key rather than by omitting a
  //                            step — they used to die by cascade with no code involved at all.
  //                            See ADD_DELETION_AUDIT.sql.
  //
  // These rows outlive the account ON PURPOSE. Anything moved out of this block needs a reason
  // recorded here and in ADD_DELETION_AUDIT.sql's header, not just a deletion someone found tidy.
  // =====================================================================================

  for (const step of steps) {
    const { error } = await purge(step);
    if (error) {
      // Stop here rather than press on: a half-cascaded account is easier to reason about than
      // one where an unknown subset survived, and the auth user still exists so the admin can
      // retry once the cause is fixed.
      console.error('[account-purge] cascade failed at', error);
      return { ok: false, error, removed };
    }
  }

  // --- Rows we KEPT that pointed back at this account ----------------------------------
  // Runs after the cascade, so a failure here can never leave data undeleted.
  await detachActor('payment_submissions',    'reviewed_by', id);
  await detachActor('password_reset_history', 'reset_by',    id);
  await detachActor('building_plan_payments', 'recorded_by', id);
  await detachActor('building_plan_requests', 'reviewed_by', id);
  await detachActor('support_tickets',        'assigned_to', id);

  return { ok: true, removed };
}
