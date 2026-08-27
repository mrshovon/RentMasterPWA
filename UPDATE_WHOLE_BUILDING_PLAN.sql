-- =====================================================================================
-- UPDATE_WHOLE_BUILDING_PLAN.sql — rewrite the Whole Building tier's public description.
--
-- WHY THIS IS SQL AND NOT CODE. The plan's name and description are DATA: rows in
-- subscription_tiers, rendered raw as {tier.name} / {tier.description} by both the public
-- /plans page and the owner Plan tab. The feature BULLETS on those cards are in the React
-- source and were updated in the same change as this file; the paragraph above them is here.
--
-- WHAT CHANGED AND WHY. The old copy leaned on the word "maintenance" with nothing qualifying
-- it. To a building committee in Bangladesh that reads as maintenance of the BUILDING — lift
-- servicing, generator, plumbing — which is the one thing the contract does not cover. Every
-- mention now says software maintenance and support, and the paragraph names the other things
-- the contract actually includes: custom feature work, app updates, help with content changes,
-- and the building's own domain on request.
--
-- SAFE TO RE-RUN. It is a single idempotent UPDATE keyed on the tier id.
--
-- The same edit can be made without SQL in Admin -> Plans -> edit "Whole Building". This file
-- exists so the wording is reviewable and version-controlled alongside the card copy it sits on.
-- =====================================================================================

update public.subscription_tiers
set
  name = 'Whole Building',
  description =
    'A private, fully-managed Bari360 for one entire building. Unlimited flats, owners and '
    || 'tenants with every module switched on, custom features built to your requirements, and '
    || 'a full year of free software maintenance, updates and support from our team — plus help '
    || 'with content changes and your own domain name on request.'
where id = 'whole_building';

-- Confirm it landed (expect exactly one row).
select id, name, billing_interval, description
from public.subscription_tiers
where id = 'whole_building';
