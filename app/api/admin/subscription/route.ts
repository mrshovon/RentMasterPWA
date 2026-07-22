import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { supabaseAdminEngine } from '@/lib/supabase-server';
import { resolveOwnerSubscription, getDisabledItemIds, countOwnerUsage } from '@/lib/subscription';
import { resolveOwnerFeatures } from '@/lib/features';

// =====================================================================================
// 🧾 OWNER — MY SUBSCRIPTION
// GET  -> effective plan state + live usage + the tiers available to activate/upgrade.
// POST -> self-activate / upgrade / renew a plan (payment mocked; no gateway yet).
//
// NOTE: This route is intentionally EXEMPT from the write-lock guard so a lapsed owner
//       can still view their plan and renew it.
// =====================================================================================

function ownerId(request: NextRequest): string | null {
  const id = request.headers.get('x-rentmaster-uid');
  if (!id || id === 'YOUR_ACTUAL_USER_UUID_FROM_DATABASE') return null;
  return id;
}

export async function GET(request: NextRequest) {
  try {
    const uid = ownerId(request);
    if (!uid) return NextResponse.json({ error: 'Context matching identity missing.' }, { status: 400 });

    const sub = await resolveOwnerSubscription(uid);

    // Live usage counts (always real, even on unlimited tiers).
    const usage = await countOwnerUsage(uid);

    // Which items are disabled (over the effective limit) so the UI can grey them.
    const { disabledPropertyIds, disabledTenantIds } = await getDisabledItemIds(uid, sub.limits);

    // Which paid modules this owner may use. Single source for the UI, so the owner
    // dashboard doesn't need a second request to decide what to render.
    const features = await resolveOwnerFeatures(uid);

    // Available plans for the upgrade/activate list.
    const { data: tiers } = await supabaseAdminEngine
      .from('subscription_tiers')
      .select('*')
      .eq('is_active', true)
      .order('price', { ascending: true });

    return NextResponse.json({
      success: true,
      subscription: sub,
      features,
      usage: {
        properties: { current: usage.properties, limit: sub.limits.maxProperties },
        tenants: { current: usage.tenants, limit: sub.limits.maxTenants },
      },
      disabled: { propertyIds: disabledPropertyIds, tenantIds: disabledTenantIds },
      availableTiers: tiers || [],
    }, { status: 200 });
  } catch (err: any) {
    console.error('Owner subscription GET error:', err);
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const uid = ownerId(request);
    if (!uid) return NextResponse.json({ error: 'Context matching identity missing.' }, { status: 400 });

    const body = await request.json();
    const tierId = body.tierId;
    if (!tierId) return NextResponse.json({ success: false, error: 'tierId is required.' }, { status: 400 });

    const { data: tier, error: tierErr } = await supabaseAdminEngine
      .from('subscription_tiers')
      .select('*')
      .eq('id', tierId)
      .maybeSingle();
    if (tierErr) throw tierErr;
    if (!tier) return NextResponse.json({ success: false, error: 'That plan does not exist.' }, { status: 404 });
    if (tier.is_active === false) {
      return NextResponse.json({ success: false, error: 'That plan is no longer available.' }, { status: 400 });
    }

    // Custom / enterprise ("Contact us") tiers are set up by the team, not self-activated.
    if (tier.billing_interval === 'custom') {
      return NextResponse.json({
        success: false,
        code: 'CONTACT_REQUIRED',
        error: `The ${tier.name} plan is set up by our team. Please contact us to enable it.`,
      }, { status: 400 });
    }

    // Paid tiers now go through the bKash payment cycle (submit -> admin approval), so this
    // route no longer self-activates them. Only free-tier switches/downgrades stay instant.
    // The frontend routes paid tiers to the payment screen (POST /api/admin/payments).
    if (Number(tier.price || 0) > 0) {
      return NextResponse.json({
        success: false,
        code: 'PAYMENT_REQUIRED',
        error: `The ${tier.name} plan requires a payment. Please complete payment to activate it.`,
      }, { status: 400 });
    }

    // Block a downgrade that would leave the owner over the target plan's limits.
    // (Upgrades and same-tier renewals never trip this — usage is already within limit.)
    const maxP = tier.max_properties_allowed ?? -1;
    const maxT = tier.max_tenants_allowed ?? -1;
    const { properties: propNow, tenants: tenantNow } = await countOwnerUsage(uid);
    if ((maxP !== -1 && propNow > maxP) || (maxT !== -1 && tenantNow > maxT)) {
      return NextResponse.json({
        success: false,
        code: 'DOWNGRADE_BLOCKED',
        error: `You're using ${propNow} propert${propNow === 1 ? 'y' : 'ies'} and ${tenantNow} tenant${tenantNow === 1 ? '' : 's'}. The ${tier.name} plan allows ${maxP === -1 ? '∞' : maxP} / ${maxT === -1 ? '∞' : maxT}. Vacate or remove the extras before switching to this plan.`,
        usage: { properties: propNow, tenants: tenantNow },
        limits: { maxProperties: maxP, maxTenants: maxT },
      }, { status: 409 });
    }

    const isFree = Number(tier.price || 0) <= 0;
    // Free = perpetual (far-future sentinel). Paid = now + one billing interval.
    const expiry = new Date();
    if (isFree) {
      expiry.setFullYear(expiry.getFullYear() + 100);
    } else if (tier.billing_interval === 'year') {
      expiry.setFullYear(expiry.getFullYear() + 1);
    } else {
      expiry.setDate(expiry.getDate() + 30);
    }

    const { error: insErr } = await supabaseAdminEngine
      .from('subscription_history')
      .insert({
        owner_id: uid,
        tier_id: tier.id,
        gateway_subscription_id: 'SELF_ACTIVATED',
        amount_paid: Number(tier.price || 0),
        status: 'active',
        expiry_date: expiry.toISOString(),
      });
    if (insErr) throw insErr;

    const sub = await resolveOwnerSubscription(uid);
    return NextResponse.json({
      success: true,
      message: isFree ? 'Free plan activated.' : `${tier.name} activated.`,
      subscription: sub,
    }, { status: 201 });
  } catch (err: any) {
    console.error('Owner subscription POST error:', err);
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}
