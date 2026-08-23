import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { supabaseAdminEngine } from '@/lib/supabase-server';
import {
  resolveOwnerSubscription, getDisabledItemIds, countOwnerUsage,
  tierVisibleToOwner, tierIsOneTime, ownerUsedTierIds,
} from '@/lib/subscription';
import { resolveOwnerFeatures } from '@/lib/features';
import { computeExpiry } from '@/lib/payments/activate';
import { buildingMembershipOf } from '@/lib/building';
import { apiError } from '@/lib/api-response';

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

    // Available plans for the upgrade/activate list. Hidden plans are filtered out here, with
    // one exception applied by tierVisibleToOwner: the owner's OWN plan stays listed even when
    // hidden, so a bespoke plan can still be seen and renewed instead of lapsing at expiry.
    // Filtered in JS, not with .eq('is_public', true) — naming that column would 42703 before
    // ADD_PLAN_VISIBILITY.sql runs and take the whole Plan tab down.
    const { data: allTiers } = await supabaseAdminEngine
      .from('subscription_tiers')
      .select('*')
      .eq('is_active', true)
      .order('price', { ascending: true });
    // `oneTimeUsed` is COMPUTED here, not a column: a one-time plan the owner has already had
    // stays in the list (greyed) rather than vanishing, so the UI can say why it isn't offered.
    const usedTierIds = await ownerUsedTierIds(uid);
    const tiers = (allTiers || [])
      .filter((t) => tierVisibleToOwner(t, sub.tierId))
      .map((t) => ({ ...t, oneTimeUsed: tierIsOneTime(t) && usedTierIds.has(t.id) }));

    // The newest lifecycle event this owner has not acknowledged, if any. Drives the one-time
    // "your plan has ended" modal on the dashboard. Failure here is non-fatal — a missing
    // plan_events table (migration unrun) must not take the whole Plan tab down with it.
    let pendingEvent: { id: string; event: string; tierName: string | null; endedAt: string | null } | null = null;
    try {
      const { data: ev } = await supabaseAdminEngine
        .from('plan_events')
        .select('id, event, tier_name, ref')
        .eq('owner_id', uid)
        .is('seen_at', null)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (ev) {
        pendingEvent = { id: ev.id, event: ev.event, tierName: ev.tier_name, endedAt: ev.ref || null };
      }
    } catch {
      /* migration not run yet — the dashboard simply shows no modal */
    }

    // A flat owner under a Whole Building plan is not the billing party — their building admin
    // is. They get the building's identity so the Plan tab can say who covers them, and an EMPTY
    // tier list so there is nothing to switch to. The POST below refuses the switch anyway; this
    // just stops the UI offering a button that can only fail.
    const membership = await buildingMembershipOf(uid);

    return NextResponse.json({
      success: true,
      subscription: sub,
      pendingEvent,
      features,
      usage: {
        properties: { current: usage.properties, limit: sub.limits.maxProperties },
        tenants: { current: usage.tenants, limit: sub.limits.maxTenants },
      },
      disabled: { propertyIds: disabledPropertyIds, tenantIds: disabledTenantIds },
      availableTiers: membership ? [] : tiers || [],
      building: membership
        ? { id: membership.buildingId, name: membership.buildingName, unitLabel: membership.unitLabel }
        : null,
    }, { status: 200 });
  } catch (err) {
    return apiError(request, err);
  }
}

export async function POST(request: NextRequest) {
  try {
    const uid = ownerId(request);
    if (!uid) return NextResponse.json({ error: 'Context matching identity missing.' }, { status: 400 });

    // Checked BEFORE the tier lookup: a flat owner under a Whole Building plan has no plan of
    // their own to change. Hiding the tier list in the UI is not a gate — this is.
    const membership = await buildingMembershipOf(uid);
    if (membership) {
      return NextResponse.json(
        {
          success: false,
          error: `Your plan is managed by ${membership.buildingName}. Contact your building administrator to change it.`,
          code: 'BUILDING_MANAGED_PLAN',
        },
        { status: 403 }
      );
    }

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

    // Hidden plans are admin-assigned only. Checked here and not merely omitted from the list
    // above, or anyone who learned a tier id could activate one. The owner already on it is
    // allowed through, so they can still renew.
    const currentSub = await resolveOwnerSubscription(uid);
    if (!tierVisibleToOwner(tier, currentSub.tierId)) {
      // Deliberately the same wording as a retired plan — a hidden plan should be
      // indistinguishable from one that does not exist.
      return NextResponse.json({ success: false, error: 'That plan is no longer available.' }, { status: 400 });
    }

    // One-time plans (trials) can be taken once. Enforced here and not just by disabling the
    // button, or the plan could be re-activated by calling this route directly.
    if (tierIsOneTime(tier) && (await ownerUsedTierIds(uid)).has(tier.id)) {
      return NextResponse.json({
        success: false,
        code: 'ONE_TIME_PLAN_USED',
        error: `${tier.name} is a one-time plan and you have already used it. Please choose another plan.`,
      }, { status: 400 });
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
    // Tenure comes from lib/payments/activate.ts — this used to be a copy of that logic,
    // including the "price <= 0 => +100 years" branch that produced year-2126 expiries.
    const expiry = computeExpiry(tier);

    const { error: insErr } = await supabaseAdminEngine
      .from('subscription_history')
      .insert({
        owner_id: uid,
        tier_id: tier.id,
        gateway_subscription_id: 'SELF_ACTIVATED',
        amount_paid: Number(tier.price || 0),
        status: 'active',
        // null = perpetual (free).
        expiry_date: expiry ? expiry.toISOString() : null,
      });
    if (insErr) throw insErr;

    const sub = await resolveOwnerSubscription(uid);
    return NextResponse.json({
      success: true,
      message: isFree ? 'Free plan activated.' : `${tier.name} activated.`,
      subscription: sub,
    }, { status: 201 });
  } catch (err) {
    return apiError(request, err);
  }
}
