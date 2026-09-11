-- A 'cancelled' state for payment_submissions.
-- Run once in the Supabase SQL editor (service role). Idempotent — safe to re-run.
--
-- ⚠️ RUN THIS BEFORE DEPLOYING the code that ships with it. The cancel route writes
-- `status = 'cancelled'`, which the existing CHECK rejects, so without this file every cancel
-- fails with a 23514 and the owner stays locked out of paying — which is the exact bug this is
-- meant to end.
--
-- WHY A NEW STATE RATHER THAN REUSING ONE
--   The gateway checkout writes a 'pending' row BEFORE redirecting to UddoktaPay, because that
--   row's id is the only thing tying the gateway's invoice back to an owner and a tier. If the
--   owner then cancels, nothing ever moves that row, so it sits at 'pending' forever — and
--   'pending' is read by two places that both then lie:
--
--     * the owner's Plan tab renders "We've received your payment … our team will review it",
--       which is false: no money moved and there is nothing to approve;
--     * findPendingSubmission() blocks any further checkout with a 409, so cancelling once
--       locked the owner out of paying at all until a super admin intervened.
--
--   'rejected' is the wrong home for these. A rejected payment is one a human looked at and
--   turned down, and it shows the owner a red "your payment could not be approved" banner with a
--   reason. A cancelled one was never submitted to anybody. ADD_UDDOKTAPAY.sql made exactly this
--   argument when it split 'refunded' out of 'rejected': collapsing distinct outcomes makes the
--   Payments queue lie about what happened.
--
--   Deleting the row was the other option, and it is what the checkout route already does when
--   createCharge() itself throws. It is rejected here only because a cancellation someone can
--   see is worth more than a clean table.
--
-- WHAT USES IT
--   1. POST /api/admin/payments/uddoktapay/cancel — the owner pressing Cancel at the gateway.
--   2. The checkout route's stale-attempt sweep: an unfinished gateway row older than 30 minutes
--      is retired the next time that owner tries to pay, so a closed tab is not a life sentence.
--
--   Both are guarded on `gateway_invoice_id is null`. That column is written only at fulfilment
--   and carries the partial unique index that is this feature's idempotency key, so a null in it
--   means no money was ever bound to the row. Nothing here can touch a real payment.

-- The constraint has had a known name since ADD_UDDOKTAPAY.sql, but drop it by CONTENT as well:
-- a database that somehow still carries the original inline-declared constraint from
-- ADD_PAYMENT_SUBMISSIONS.sql has a Postgres-generated name instead, and the add below would
-- then fail against a constraint this file never saw. Finding it by what it contains covers both.
do $$
declare c record;
begin
  for c in
    select conname
      from pg_constraint
     where conrelid = 'public.payment_submissions'::regclass
       and contype  = 'c'
       and pg_get_constraintdef(oid) ilike '%rejected%'
  loop
    execute format('alter table public.payment_submissions drop constraint %I', c.conname);
  end loop;
end $$;

alter table public.payment_submissions
  add constraint payment_submissions_status_check
  check (status in ('pending', 'approved', 'rejected', 'refunded', 'cancelled'));

-- Retire the rows this bug already stranded: unfinished gateway attempts with no invoice bound.
-- Without this, owners who cancelled before today stay locked out even once the code ships, and
-- their dead rows keep sitting in the super admin's approve/reject queue.
--
-- Deliberately scoped to provider = 'uddoktapay': a pending manual_bkash row means somebody
-- really did send money and is waiting on a human, and must not be swept.
update public.payment_submissions
   set status      = 'cancelled',
       admin_notes = coalesce(admin_notes, 'Abandoned checkout — no payment was completed.'),
       updated_at  = now()
 where provider           = 'uddoktapay'
   and status             = 'pending'
   and gateway_invoice_id is null;
