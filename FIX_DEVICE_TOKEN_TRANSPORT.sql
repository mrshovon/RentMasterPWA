-- Repair device_tokens rows whose `device_type` misdescribes their transport.
-- Run once in the Supabase SQL editor (service role). Idempotent — safe to re-run.
--
-- WHY: the browser used to send the operating system as `deviceDetails`, so a PWA installed
-- on an Android phone registered its WEB PUSH subscription as device_type = 'android' — the
-- value the backend reserves for native FCM registration tokens. Delivery then routed those
-- subscriptions to FCM, which cannot use a Web Push endpoint URL as a token, so:
--   * the device never received anything over Web Push, and
--   * once Firebase credentials went live, FCM answered `invalid-argument` and the dead-token
--     pruning DELETED the row on every send.
--
-- The code fix derives transport from the payload instead (a row with p256dh + auth IS Web
-- Push, whatever the label says — see lib/push-send.ts), so delivery is already correct
-- without this script. This is a consistency fix: it stops the column from lying, so nobody
-- reading the table draws the wrong conclusion again.
--
-- Web Push rows are identifiable beyond doubt: only they carry the ECDH crypto keys
-- (p256dh/auth). Native FCM rows have both as NULL, so they can never be caught by this.

update public.device_tokens
   set device_type = 'web'
 where device_type = 'android'
   and p256dh is not null
   and auth   is not null;

-- Check: every remaining 'android' row must be a genuine native token (no crypto keys).
-- Expect 0. (Counting rather than listing: `token` holds the push endpoint, which is
-- bearer-grade and should not be pasted into a console.)
select count(*) as misrouted_rows_remaining
  from public.device_tokens
 where device_type = 'android'
   and p256dh is not null;
