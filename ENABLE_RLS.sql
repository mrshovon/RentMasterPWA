-- =============================================================================
-- RentMaster — Enable Row Level Security (fixes audit finding C2)
--
-- WHY: The public anon key is embedded in the frontend JS. Without RLS, anyone can
-- read your tables directly via the Supabase REST API, bypassing the app entirely
-- (verified: anon could SELECT tenants, properties, user_profiles, billing_ledgers).
--
-- WHAT THIS DOES: Enables RLS on every app table and adds NO permissive policies, so
-- the anon and authenticated (logged-in-Supabase-user) roles get ZERO direct access.
-- Your backend uses the SERVICE ROLE key (`supabaseAdminEngine`), which BYPASSES RLS,
-- so the app keeps working exactly as before — all access still flows through your
-- Next.js routes and their auth checks.
--
-- HOW TO RUN: Supabase Dashboard → SQL Editor → paste → Run. Safe to re-run.
-- AFTER RUNNING: re-test the app (owner/tenant/admin) and re-run the anon probe — the
-- anon SELECTs that returned 200 should now return an RLS error / empty-forbidden.
-- =============================================================================

ALTER TABLE public.properties                 ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tenants                    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.billing_ledgers            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.notices                    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.maintenance_logs           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.documents                  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_profiles              ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.subscription_history       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.subscription_tiers         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.device_tokens              ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.service_charge_breakdowns  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.rent_revision_archives     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.property_occupancy_history ENABLE ROW LEVEL SECURITY;

-- Also revoke the default table privileges Supabase grants to the public API roles,
-- so even with RLS on there is no lingering column/table-level access. (Belt & braces.)
REVOKE ALL ON public.properties,
              public.tenants,
              public.billing_ledgers,
              public.notices,
              public.maintenance_logs,
              public.documents,
              public.user_profiles,
              public.subscription_history,
              public.subscription_tiers,
              public.device_tokens,
              public.service_charge_breakdowns,
              public.rent_revision_archives,
              public.property_occupancy_history
  FROM anon, authenticated;

-- =============================================================================
-- OPTIONAL: if you later add direct-from-browser Supabase reads (you don't need this
-- today — the app uses the service role), add narrowly-scoped policies, e.g.:
--
--   CREATE POLICY "tiers are publicly readable"
--     ON public.subscription_tiers FOR SELECT TO anon USING (true);
--
-- Do NOT add blanket policies to tenants / billing_ledgers / user_profiles.
-- =============================================================================
