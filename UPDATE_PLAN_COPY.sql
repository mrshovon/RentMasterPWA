-- =====================================================================================
-- UPDATE_PLAN_COPY.sql — real copy for the Free and Premium tiers.
--
-- WHY. Both rows still carried placeholder text that had never been rewritten. Live on
-- www.bari360.space/plans as of 2026-08-27:
--
--   free_tier        "Free Baseline Tracking"
--                    "Provides basic mapping operations up to 1 distinct physical
--                     property footprints"
--   premium_monthly  "Premium Pro Plan Upgrade"
--                    "Provides enterprise scaling capabilities, custom background
--                     parameters, and automated browser alerts layers"
--
-- Neither describes the product. "Mapping operations" and "automated browser alerts
-- layers" are not features this app has. This was found while translating the plan cards
-- into Bangla — translating that text would only have produced nonsense in two languages.
--
-- WHY IT IS SQL. name and description are DATA: subscription_tiers rows rendered as
-- {tier.name} / {tier.description} by the public /plans page and the owner Plan tab. Same
-- reasoning as UPDATE_WHOLE_BUILDING_PLAN.sql, whose whole_building row is already correct
-- and is deliberately not touched here.
--
-- ⚠️ PAIRS WITH lib/locales/bn.ts. The English string IS the dictionary key
-- (lib/i18n.tsx: DICTIONARIES[lang][text] ?? text), so the Bangla entries added in the
-- same change must match these strings BYTE FOR BYTE — including the em dashes. Change one
-- without the other and the card silently falls back to English for Bangla readers, which
-- is the exact failure the batch this file belongs to exists to fix.
--
-- NOT CHANGED: the 1 property / 1 tenant limits on free_tier. Those are correct and
-- deliberate; only the words were wrong.
--
-- SAFE TO RE-RUN. Two idempotent UPDATEs keyed on the tier id.
-- =====================================================================================

update public.subscription_tiers
set
  name = 'Free',
  description =
    'The full dashboard for one rented property — rent invoices, money receipts, tenant '
    || 'sign-in, maintenance requests and notices. One property and one tenant, free for '
    || 'as long as you use it.'
where id = 'free_tier';

update public.subscription_tiers
set
  name = 'Premium',
  description =
    'Unlimited properties and unlimited tenants, with everything in the Free plan. Billed '
    || 'once a year and activated as soon as we confirm your bKash payment.'
where id = 'premium_monthly';

-- Confirm all three tiers read sensibly (expect 3 rows).
select id, name, price, billing_interval,
       max_properties_allowed, max_tenants_allowed, description
from public.subscription_tiers
order by price, id;
