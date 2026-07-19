-- Fix: contact_messages.tier_id was declared uuid, but subscription_tiers.id values are
-- human-readable text slugs ('free_tier', 'premium_monthly', 'whole_building'). Inserting a
-- slug (e.g. the "Whole Building" contact-us enquiry) failed with:
--   invalid input syntax for type uuid: "whole_building"
--
-- Widen the column to text to match subscription_tiers.id. Run once in the Supabase SQL editor
-- (service role). Idempotent: re-running when the column is already text is a no-op alter.

alter table public.contact_messages
  alter column tier_id type text using tier_id::text;
