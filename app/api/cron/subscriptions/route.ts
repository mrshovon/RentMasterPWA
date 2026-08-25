import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import crypto from 'crypto';
import { supabaseAdminEngine } from '@/lib/supabase-server';
import { resolveOwnerSubscription, type OwnerSubscription } from '@/lib/subscription';
import { notifyOwner } from '@/lib/notify';
import { sendEmail } from '@/lib/email/brevo';
import { planEvent as planEventEmail } from '@/lib/email/templates';
import { resolveAppBaseUrl } from '@/lib/public-url';
import { logEvent, describeError } from '@/lib/logger';
import { buildingPlanState, type BuildingSubscriptionRow } from '@/lib/building-plan';

// =====================================================================================
// ⏰ CRON — subscription lifecycle notifications.
//
// Subscription state is COMPUTED from expiry_date and the clock (see lib/subscription.ts), so an
// expiry is not an event: the answer just changes the next time someone asks. Which meant that
// until this route existed, an owner's plan could warn, expire and downgrade with the app never
// once telling them — the only signal was a banner they had to open the app to see.
//
// This is the missing edge detector. Once a day it resolves every owner who has ever had a plan,
// works out which transition they are in, and — ONCE per transition — writes an in-app notice,
// fires a push, and sends an email.
//
// Idempotency is the whole design. Everything hangs off the unique index on
// plan_events(owner_id, event, ref): the insert is attempted FIRST, and only a row that did not
// already exist earns a notification. So this route is safe to run twice, safe to re-run by hand,
// and safe when a deploy overlaps a scheduled run — which matters, because the alternative
// failure (mailing every owner their expiry warning every single morning) is the kind that gets
// an app's sending domain blocked.
//
// Public path (middleware only gates /api/admin, /api/super-admin, /api/notifications), so like
// /api/cron/reminders it authorises itself with CRON_SECRET. Vercel Cron sends it as a Bearer
// header automatically; ?secret= is there for manual triggering. See vercel.json.
// =====================================================================================

export const dynamic = 'force-dynamic';
/** Owners are processed serially against Supabase; give the run room on a large account base. */
export const maxDuration = 60;

/** app_logs rows older than this are dropped at the end of the run. */
const LOG_RETENTION_DAYS = 30;

type PlanEventKind = 'expiring_soon' | 'grace_started' | 'downgraded';

function authorized(request: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false; // fail closed: no secret configured => no delivery
  if (request.headers.get('authorization') === `Bearer ${secret}`) return true;
  return request.nextUrl.searchParams.get('secret') === secret;
}

/**
 * Which transition, if any, this owner is in right now.
 *
 * `ref` ties the event to the expiry date it belongs to, so a renewal produces a genuinely new
 * event rather than being swallowed by the dedupe index.
 */
function classify(sub: OwnerSubscription): { kind: PlanEventKind; ref: string; days: number } | null {
  if (sub.permissionsRevoked) return null; // an admin revoke is not a billing event

  if (sub.downgradedFrom) {
    return { kind: 'downgraded', ref: sub.downgradedFrom.endedAt || '', days: 0 };
  }
  if (sub.status === 'grace') {
    return { kind: 'grace_started', ref: sub.expiryDate || '', days: sub.daysLeftInGrace ?? 0 };
  }
  // Computed by resolveOwnerSubscription since the beginning and, until now, read by nothing.
  if (sub.warnExpiringSoon) {
    return { kind: 'expiring_soon', ref: sub.expiryDate || '', days: sub.daysUntilExpiry ?? 0 };
  }
  return null;
}

function messageFor(
  kind: PlanEventKind,
  tierName: string,
  days: number,
  limits: { maxProperties: number; maxTenants: number },
): { title: string; body: string } {
  const plural = (n: number) => (n === 1 ? '' : 's');

  // Fixed, quotable strings: rent-master-pwa-ui/lib/notice-i18n.ts translates the in-app copy by
  // exact match, so these must stay character-identical to the entries added there.
  switch (kind) {
    case 'expiring_soon':
      return {
        title: 'Your plan expires soon',
        body: `Your ${tierName} plan expires in ${days} day${plural(days)}. Renew now to keep everything as it is.`,
      };
    case 'grace_started':
      return {
        title: 'Your plan has expired',
        body: `Your ${tierName} plan has expired. You have ${days} day${plural(days)} left to renew before your account moves to the free plan.`,
      };
    case 'downgraded':
      return {
        title: 'Your plan has ended',
        body: `Your ${tierName} plan has ended and you are now on the free plan — ${limits.maxProperties} propert${limits.maxProperties === 1 ? 'y' : 'ies'} and ${limits.maxTenants} tenant${plural(limits.maxTenants)}. Nothing has been deleted; anything beyond those limits is view-only until you choose a plan.`,
      };
  }
}

/** One entry in a dry run's report: what this owner WOULD be sent, and whether they already were. */
interface WouldSend {
  ownerId: string;
  email: string | null;
  event: PlanEventKind;
  tierName: string;
  days: number;
  ref: string;
  /** True when a plan_events row already exists — the real run would skip this one. */
  alreadySent: boolean;
  title: string;
  body: string;
}

// =====================================================================================
// THE BUILDING PASS
//
// A second, independent sweep over building_subscriptions. It lives in this route rather than a
// third cron entry because it is the same job — "tell people about their billing state before it
// bites them" — and because one daily wake-up is cheaper than two.
//
// It is deliberately NOT folded into the owner loop above. Owners are keyed by owner_id off
// subscription_history and classified from a tier expiry; buildings are keyed by building_id off
// their own contract and have an event the owner lifecycle has no concept of (pay_due, the
// countdown before a building that has never paid locks). Merging them would put two sets of
// branches in one loop, each half-applicable.
//
// Idempotency is identical in shape: CLAIM the building_plan_events row first, and only a claim
// that actually inserted earns a notification. `ref` is the date the event belongs to, so a
// renewed term produces a genuinely new event instead of being swallowed forever.
// =====================================================================================

type BuildingEventKind = 'pay_due' | 'expiring_soon' | 'grace_started' | 'locked';

interface BuildingWouldSend {
  buildingId: string;
  buildingName: string;
  event: BuildingEventKind;
  days: number;
  ref: string;
  alreadySent: boolean;
  title: string;
  body: string;
}

/** Which transition, if any, this building is in right now. Null means nothing to say today. */
function classifyBuilding(
  row: BuildingSubscriptionRow,
): { kind: BuildingEventKind; ref: string; days: number } | null {
  const state = buildingPlanState(row);

  // A cancelled contract is an administrative act, not a billing event — the same reason an
  // admin revoke is skipped in the owner pass. Someone has already had that conversation.
  if (row.canceled_at) return null;

  if (state.unpaidWindow) {
    // Locked for non-payment, or still counting down: both hang off the pay-by date, so a
    // building is told once that it is due and once that it has locked.
    if (state.status === 'locked') {
      return { kind: 'locked', ref: String(row.pay_by || ''), days: 0 };
    }
    return { kind: 'pay_due', ref: String(row.pay_by || ''), days: state.daysToPay ?? 0 };
  }
  if (state.status === 'locked') {
    return { kind: 'locked', ref: String(row.expiry_date || ''), days: 0 };
  }
  if (state.status === 'grace') {
    return { kind: 'grace_started', ref: String(row.expiry_date || ''), days: state.daysLeftInGrace ?? 0 };
  }
  if (state.warnExpiringSoon) {
    return { kind: 'expiring_soon', ref: String(row.expiry_date || ''), days: state.daysUntilExpiry ?? 0 };
  }
  return null;
}

/** Fixed, quotable copy — see the note in lib/notify.ts about push text and notice-i18n.ts. */
function buildingMessageFor(kind: BuildingEventKind, name: string, days: number): { title: string; body: string } {
  const plural = (n: number) => (n === 1 ? '' : 's');
  switch (kind) {
    case 'pay_due':
      return {
        title: 'Payment due for your building plan',
        body: `${name} has ${days} day${plural(days)} left to pay. After that, management is locked for you and your flat owners.`,
      };
    case 'expiring_soon':
      return {
        title: 'Your building plan is expiring',
        body: `${name}'s plan expires in ${days} day${plural(days)}. Request a renewal from your Plan tab.`,
      };
    case 'grace_started':
      return {
        title: 'Your building plan has expired',
        body: `${name}'s plan has expired. ${days} day${plural(days)} of grace left to renew before management is locked.`,
      };
    case 'locked':
      return {
        title: 'Your building plan is locked',
        body: `${name} is now read-only for you and your flat owners. Renew from your Plan tab to restore access.`,
      };
  }
}

async function runBuildingPass(dryRun: boolean) {
  const summary = { buildings: 0, pay_due: 0, expiring_soon: 0, grace_started: 0, locked: 0, failed: 0 };
  const would: BuildingWouldSend[] = [];
  let skipped = 0;

  // A missing table (ADD_BUILDING_PLANS.sql unrun) must not take the owner pass down with it —
  // that half of the job is live and unrelated.
  let rows: BuildingSubscriptionRow[] = [];
  try {
    const { data, error } = await supabaseAdminEngine.from('building_subscriptions').select('*');
    if (error) throw error;
    rows = (data || []) as BuildingSubscriptionRow[];
  } catch {
    return { summary, would, skipped };
  }

  // One lookup for every name, rather than one per building inside the loop.
  const names = new Map<string, string>();
  try {
    const { data } = await supabaseAdminEngine.from('buildings').select('id, name');
    (data || []).forEach((b: any) => names.set(b.id, b.name || 'Your building'));
  } catch {
    /* a nameless building still gets told; the copy just says "Your building" */
  }

  for (const row of rows) {
    try {
      const hit = classifyBuilding(row);
      if (!hit) continue;
      summary.buildings += 1;
      summary[hit.kind] += 1;

      const name = names.get(row.building_id) || 'Your building';
      const msg = buildingMessageFor(hit.kind, name, hit.days);

      if (dryRun) {
        const { data: seen } = await supabaseAdminEngine
          .from('building_plan_events')
          .select('id')
          .eq('building_id', row.building_id)
          .eq('event', hit.kind)
          .eq('ref', hit.ref)
          .maybeSingle();
        if (seen) skipped += 1;
        would.push({
          buildingId: row.building_id,
          buildingName: name,
          event: hit.kind,
          days: hit.days,
          ref: hit.ref,
          alreadySent: !!seen,
          title: msg.title,
          body: msg.body,
        });
        continue;
      }

      // Claim first. Only a row that did not already exist earns a notification.
      const { data: claimed, error: claimErr } = await supabaseAdminEngine
        .from('building_plan_events')
        .upsert(
          {
            id: crypto.randomUUID(),
            building_id: row.building_id,
            admin_id: row.admin_id,
            event: hit.kind,
            ref: hit.ref,
          },
          { onConflict: 'building_id,event,ref', ignoreDuplicates: true },
        )
        .select('id');
      if (claimErr) throw claimErr;
      if (!claimed || claimed.length === 0) {
        skipped += 1;
        summary.buildings -= 1;
        summary[hit.kind] -= 1;
        continue;
      }

      await notifyOwner({
        userId: row.admin_id,
        title: msg.title,
        body: msg.body,
        url: '/building#plan',
        tag: `building-plan-${hit.kind}-${row.building_id}`,
      });
    } catch (err) {
      summary.failed += 1;
      await logEvent({
        source: 'cron',
        message: `Building plan check failed for ${row.building_id}`,
        detail: describeError(err).detail,
        route: '/api/cron/subscriptions',
        context: { buildingId: row.building_id },
      });
    }
  }

  return { summary, would, skipped };
}

async function run(request: NextRequest) {
  if (!authorized(request)) {
    return NextResponse.json({ success: false, error: 'Unauthorized.' }, { status: 401 });
  }

  // DRY RUN — classify and report, change nothing.
  //
  // This job messages the entire owner base at once. Being able to read the exact copy and the
  // exact recipient list BEFORE any of it goes out is the difference between a mistake and a
  // caught mistake, and a notification cannot be unsent.
  //
  // Nothing is written and nothing is sent: no plan_events claim, no notice, no push, no email,
  // and no log purge.
  const dryRun = ['1', 'true', 'yes'].includes(
    (request.nextUrl.searchParams.get('dryRun') || '').toLowerCase(),
  );

  const appUrl = resolveAppBaseUrl(request);
  const summary = { owners: 0, expiring_soon: 0, grace_started: 0, downgraded: 0, failed: 0 };
  const would: WouldSend[] = [];
  let skipped = 0;

  // Only owners who have ever been on a plan can have a lifecycle event. Someone who has always
  // been on the implicit free baseline has no expiry to cross, so there is nothing to tell them.
  const { data: rows, error } = await supabaseAdminEngine
    .from('subscription_history')
    .select('owner_id');
  if (error) {
    await logEvent({
      source: 'cron',
      message: 'Subscription cron could not list owners',
      detail: describeError(error).detail,
      route: '/api/cron/subscriptions',
    });
    return NextResponse.json({ success: false, error: 'Could not list owners.' }, { status: 500 });
  }

  // ⚠️ Building admins are excluded from the OWNER pass, and this is not an optimisation.
  //
  // A building admin holds a subscription_history row for the whole_building tier, so they turn
  // up in the list above like any owner. But resolveOwnerSubscription() now overlays their
  // BUILDING CONTRACT onto that plan, so classify() would read the contract's expiry and fire an
  // owner-worded "your plan expires in N days" — on top of the building-worded one the pass
  // below sends off the same date. Two notifications, two dedupe tables, one event.
  //
  // The building pass owns every message about a building's billing state. Skipping them here is
  // what keeps that true. Best-effort: if this lookup fails we skip nobody, which restores the
  // old (pre-contract) behaviour rather than silencing the owner pass entirely.
  const buildingAdminIds = new Set<string>();
  try {
    const { data: contracts } = await supabaseAdminEngine
      .from('building_subscriptions')
      .select('admin_id');
    (contracts || []).forEach((c: { admin_id: string }) => {
      if (c.admin_id) buildingAdminIds.add(c.admin_id);
    });
  } catch {
    /* table not created yet — nothing to exclude, which is exactly how this ran before */
  }

  const ownerIds = Array.from(
    new Set((rows || []).map((r: { owner_id: string }) => r.owner_id).filter(Boolean)),
  ).filter((id) => !buildingAdminIds.has(id));

  for (const ownerId of ownerIds) {
    summary.owners++;
    try {
      const sub = await resolveOwnerSubscription(ownerId);
      const hit = classify(sub);
      if (!hit) continue;

      const tierName = sub.downgradedFrom?.tierName || sub.tierName;
      const tierId = sub.downgradedFrom?.tierId || sub.tierId;

      if (dryRun) {
        // A live run only notifies when its plan_events insert CLAIMS a new row, so an honest dry
        // run has to read the same table. Without this it would report events the real run would
        // correctly skip, which is precisely the reassurance a dry run is supposed to provide.
        const { data: existing } = await supabaseAdminEngine
          .from('plan_events')
          .select('id')
          .eq('owner_id', ownerId)
          .eq('event', hit.kind)
          .eq('ref', hit.ref)
          .maybeSingle();

        const { title, body } = messageFor(hit.kind, tierName, hit.days, sub.limits);
        let email: string | null = null;
        try {
          const { data: authRes } = await supabaseAdminEngine.auth.admin.getUserById(ownerId);
          email = authRes?.user?.email ?? null;
        } catch { /* the report is still useful without it */ }

        would.push({
          ownerId, email, event: hit.kind, tierName, days: hit.days, ref: hit.ref,
          alreadySent: !!existing, title, body,
        });
        if (existing) skipped++; else summary[hit.kind]++;
        continue;
      }

      // Claim the event BEFORE notifying. If the insert conflicts, someone (or a previous run)
      // has already told this owner and we stop here — that ordering is what makes a duplicate
      // run send nothing rather than send twice.
      const { data: claimed, error: claimErr } = await supabaseAdminEngine
        .from('plan_events')
        .upsert(
          {
            id: crypto.randomUUID(),
            owner_id: ownerId,
            event: hit.kind,
            tier_id: tierId,
            tier_name: tierName,
            ref: hit.ref,
          },
          { onConflict: 'owner_id,event,ref', ignoreDuplicates: true },
        )
        .select('id');
      if (claimErr) throw claimErr;
      if (!claimed || claimed.length === 0) continue; // already sent

      const { title, body } = messageFor(hit.kind, tierName, hit.days, sub.limits);

      // In-app notice + push. Non-fatal inside notifyOwner.
      await notifyOwner({
        userId: ownerId,
        title,
        body,
        url: '/owner#plan',
        tag: `plan-${hit.kind}-${ownerId}`,
      });

      // Email. Best-effort and silent when Brevo is not connected.
      try {
        const { data: authRes } = await supabaseAdminEngine.auth.admin.getUserById(ownerId);
        const email = authRes?.user?.email;
        if (email) {
          await sendEmail({
            to: email,
            toName: (authRes?.user?.user_metadata as any)?.name || null,
            ...planEventEmail({
              name: (authRes?.user?.user_metadata as any)?.name || '',
              event: hit.kind,
              tierName,
              days: hit.days,
              appUrl,
              freeLimits: { properties: sub.limits.maxProperties, tenants: sub.limits.maxTenants },
            }),
          });
        }
      } catch (mailErr) {
        await logEvent({
          level: 'warn',
          source: 'email',
          message: `Plan ${hit.kind} email failed for owner ${ownerId}`,
          detail: describeError(mailErr).detail,
        });
      }

      summary[hit.kind]++;
    } catch (err) {
      // One owner's failure must not abandon the rest of the run.
      summary.failed++;
      await logEvent({
        source: 'cron',
        message: `Subscription check failed for owner ${ownerId}`,
        detail: describeError(err).detail,
        route: '/api/cron/subscriptions',
        context: { ownerId },
      });
    }
  }

  // The building contracts, swept independently — see the header above runBuildingPass().
  const buildings = await runBuildingPass(dryRun);

  if (dryRun) {
    return NextResponse.json(
      {
        success: true,
        dryRun: true,
        owners: summary.owners,
        counts: {
          expiring_soon: summary.expiring_soon,
          grace_started: summary.grace_started,
          downgraded: summary.downgraded,
          alreadySent: skipped,
          failed: summary.failed,
        },
        would,
        buildings: {
          counts: { ...buildings.summary, alreadySent: buildings.skipped },
          would: buildings.would,
        },
      },
      { status: 200, headers: { 'Cache-Control': 'no-store' } },
    );
  }

  // Log retention, folded into this run rather than given a third cron entry.
  let purged = 0;
  try {
    const cutoff = new Date(Date.now() - LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();
    const { count } = await supabaseAdminEngine
      .from('app_logs')
      .delete({ count: 'exact' })
      .lt('created_at', cutoff);
    purged = count || 0;
  } catch {
    /* the table may not exist yet (ADD_APP_LOGS.sql unrun) — never fail the run over cleanup */
  }

  return NextResponse.json(
    { success: true, ...summary, buildings: buildings.summary, logsPurged: purged },
    { status: 200 },
  );
}

// Vercel Cron issues a GET; POST supported for manual triggering.
export async function GET(request: NextRequest) { return run(request); }
export async function POST(request: NextRequest) { return run(request); }
