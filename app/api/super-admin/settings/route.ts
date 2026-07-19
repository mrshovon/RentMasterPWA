import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { getDefaultSignupTier, setSetting } from '@/lib/app-settings';
import { supabaseAdminEngine } from '@/lib/supabase-server';

// =====================================================================================
// PLATFORM SETTINGS — ADMIN
// GET   -> current platform settings (currently: default signup tier).
// PATCH -> update default_signup_tier ({ tierId }). Empty string => new owners are free.
//
// Admin-only via the /api/super-admin/* gate in middleware.ts.
// =====================================================================================

export async function GET() {
  try {
    const defaultSignupTier = await getDefaultSignupTier();
    return NextResponse.json({ success: true, data: { defaultSignupTier } }, { status: 200 });
  } catch (err: any) {
    console.error('Settings GET error:', err);
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const body = await request.json();
    if (body.tierId === undefined) {
      return NextResponse.json({ success: false, error: 'tierId is required (use "" for free).' }, { status: 400 });
    }

    const tierId = String(body.tierId || '').trim();

    // Validate a non-empty tier: must exist, be active, and not be a custom/contact tier.
    if (tierId) {
      const { data: tier } = await supabaseAdminEngine
        .from('subscription_tiers')
        .select('id, is_active, billing_interval')
        .eq('id', tierId)
        .maybeSingle();
      if (!tier || tier.is_active === false) {
        return NextResponse.json({ success: false, error: 'That plan is not available.' }, { status: 400 });
      }
      if (tier.billing_interval === 'custom') {
        return NextResponse.json({ success: false, error: 'A custom/contact plan cannot be a signup default.' }, { status: 400 });
      }
    }

    await setSetting('default_signup_tier', { tierId });
    return NextResponse.json({ success: true, data: { defaultSignupTier: { tierId } } }, { status: 200 });
  } catch (err: any) {
    console.error('Settings PATCH error:', err);
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}
