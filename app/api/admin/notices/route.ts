import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { supabaseAdminEngine } from '../../../../lib/supabase-server';
import { assertOwnerCanWrite } from '../../../../lib/subscription';
import { sendPushToUsers, sendPushToRole } from '../../../../lib/push-send';
import crypto from 'crypto';
import { apiError } from '@/lib/api-response';

// Audiences a notice can address. See ADD_NOTICE_TARGETS.sql for the matching DB constraint.
const VALID_SCOPES = [
  'everyone', 'all_owners', 'all_tenants', 'individual_owner', 'individual_tenant',
] as const;

// Platform-wide audiences belong to the super-admin alone. An owner circulating to
// 'all_tenants' reaches THEIR tenants only (enforced in the GET filter below); the other
// scopes would cross owner boundaries, so owners may not use them at all.
const ADMIN_ONLY_SCOPES: string[] = ['everyone', 'all_owners', 'individual_owner'];

// =====================================================================================
// 🚀 NOTICE DISPATCH ENGINE: RECORD BROADCAST ANNOUNCEMENTS (POST)
// =====================================================================================
export async function POST(request: NextRequest) {
  try {
    const ownerId = request.headers.get('x-rentmaster-uid');
    const role = request.headers.get('x-rentmaster-role');

    if (!ownerId) {
      return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 });
    }

    // Owner write-lock (admin 'system_admin' circulations use role 'admin' and pass through).
    const guard = await assertOwnerCanWrite(role, ownerId);
    if (!guard.ok) return NextResponse.json(guard.body, { status: guard.status });

    const bodyPayload = await request.json();
    const {
      senderType, // 'owner' or 'system_admin'
      // 'everyone' | 'all_owners' | 'all_tenants' | 'individual_owner' | 'individual_tenant'
      targetScope,
      targetTenantId,
      targetOwnerId,
      title,
      content
    } = bodyPayload;

    // Boundary Validation Constraints Checks
    if (!senderType || !targetScope || !title || !content) {
      return NextResponse.json({ error: 'Compulsory payload fields matching validation constraints missing.' }, { status: 400 });
    }

    if (!(VALID_SCOPES as readonly string[]).includes(targetScope)) {
      return NextResponse.json({ error: `Unknown target scope "${targetScope}".` }, { status: 400 });
    }

    // Platform-wide audiences are the super-admin's alone: an owner may only ever address their
    // own tenants, never other owners or the whole tenant base.
    if (ADMIN_ONLY_SCOPES.includes(targetScope) && role !== 'admin') {
      return NextResponse.json({ error: 'Only a platform administrator can circulate to that audience.' }, { status: 403 });
    }

    if (targetScope === 'individual_tenant' && !targetTenantId) {
      return NextResponse.json({ error: 'Target tenant ID must be provided when scope is mapped to an individual.' }, { status: 400 });
    }

    if (targetScope === 'individual_owner' && !targetOwnerId) {
      return NextResponse.json({ error: 'Target owner ID must be provided when circulating to a single owner.' }, { status: 400 });
    }

    const noticeRecordId = crypto.randomUUID();

    const { data: createdNotice, error: databaseInsertException } = await supabaseAdminEngine
      .from('notices')
      .insert([
        {
          id: noticeRecordId,
          sender_type: senderType,
          sender_id: ownerId, // Maps the creating session identity safely
          target_scope: targetScope,
          target_tenant_id: targetScope === 'individual_tenant' ? targetTenantId : null,
          target_owner_id: targetScope === 'individual_owner' ? targetOwnerId : null,
          title: title,
          content: content
        }
      ])
      .select()
      .single();

    if (databaseInsertException) {
      return apiError(request, databaseInsertException);
    }

    // Fire-and-forget Web Push to the notice's audience (never block/fail the response on push).
    const pushPayload = {
      title: title,
      body: String(content).slice(0, 180),
      tag: `notice-${noticeRecordId}`,
    };
    try {
      if (targetScope === 'individual_tenant') {
        await sendPushToUsers([targetTenantId], { ...pushPayload, url: '/tenant' });
      } else if (targetScope === 'individual_owner') {
        await sendPushToUsers([targetOwnerId], { ...pushPayload, url: '/owner' });
      } else if (targetScope === 'all_tenants') {
        // An owner's broadcast pushes to their own tenants; the admin's goes to every tenant.
        if (role === 'admin') {
          await sendPushToRole('tenant', { ...pushPayload, url: '/tenant' });
        } else {
          const { data: ownTenants } = await supabaseAdminEngine
            .from('tenants').select('id').eq('owner_id', ownerId);
          const ids = (ownTenants || []).map((t: { id: string }) => t.id);
          if (ids.length) await sendPushToUsers(ids, { ...pushPayload, url: '/tenant' });
        }
      } else if (targetScope === 'all_owners') {
        await sendPushToRole('owner', { ...pushPayload, url: '/owner' });
      } else if (targetScope === 'everyone') {
        await sendPushToRole('owner', { ...pushPayload, url: '/owner' });
        await sendPushToRole('tenant', { ...pushPayload, url: '/tenant' });
      }
    } catch (pushErr) {
      console.error('[notices] push dispatch failed (non-fatal):', pushErr);
    }

    return NextResponse.json({
      success: true,
      message: 'Notice broadcast registry logged successfully.',
      data: createdNotice
    }, { status: 201 });

  } catch (runtimeExceptionCatch) {
    return apiError(request, runtimeExceptionCatch);
  }
}

/**
 * Resolve the date an owner's account was created — the cutoff for their notice feed.
 *
 * This used to be a bare `await getUserById()` inside a try/catch, which had a hole big
 * enough to be the whole bug: supabase-js returns `{ data, error }` rather than throwing, so
 * an auth-API *error* never reached the catch. It just produced `undefined -> null`, the
 * `.gte()` was silently skipped, and the reader got the entire historical feed. That API
 * does fail intermittently, so the symptom was "sometimes I see notices from before I
 * signed up" — which is exactly what was reported.
 *
 * Now: check the error, retry once (these failures are transient), then fall back to
 * `user_profiles.created_at`, which is written by the signup upsert and is a good proxy.
 * Only if every source fails do we serve unfiltered, and then we say so loudly.
 */
async function resolveOwnerJoinDate(ownerId: string): Promise<{ joinedAt: string | null; source: string }> {
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const { data, error } = await supabaseAdminEngine.auth.admin.getUserById(ownerId);
      if (!error && data?.user?.created_at) {
        return { joinedAt: data.user.created_at, source: 'auth.users' };
      }
      console.warn(`[notices] getUserById attempt ${attempt} gave no signup date for ${ownerId}:`, error?.message || 'no user');
    } catch (err) {
      console.warn(`[notices] getUserById attempt ${attempt} threw for ${ownerId}:`, err);
    }
  }

  // Fallback: the profile mirror. Created by the signup upsert, so its created_at default
  // lands within seconds of the real signup.
  const { data: profile, error: profileErr } = await supabaseAdminEngine
    .from('user_profiles').select('created_at').eq('id', ownerId).maybeSingle();
  if (!profileErr && profile?.created_at) {
    console.warn(`[notices] falling back to user_profiles.created_at for ${ownerId}`);
    return { joinedAt: profile.created_at, source: 'user_profiles' };
  }

  console.error(
    `[notices] could not resolve a signup date for owner ${ownerId} from auth.users OR ` +
    `user_profiles — serving the UNFILTERED feed, so this reader may see notices published ` +
    `before their account existed.`
  );
  return { joinedAt: null, source: 'unresolved' };
}

// =====================================================================================
// 🚀 ADAPTIVE NOTICE FETCH LAYER: STREAM RELEVANT ANNOUNCEMENTS PLACARDS (GET)
// =====================================================================================
export async function GET(request: NextRequest) {
  try {
    const ownerId = request.headers.get('x-rentmaster-uid');
    const tenantId = request.headers.get('x-rentmaster-tenant-id');

    if (!ownerId && !tenantId) {
      return NextResponse.json({ error: 'Context identity signature parameter extraction missing.' }, { status: 400 });
    }

    // The audience filter, as a list of PostgREST `or` clauses. Kept as data (not applied
    // straight onto the builder) so the pre-migration fallback below can drop one clause and
    // re-run without rebuilding the whole query.
    let clauses: string[] = [];
    let dynamicTraceLogContext = "";

    // When this account was created. Notices predating it are somebody else's history — a tenant
    // who moved in this month has no business reading last year's building announcements.
    //
    // Resolved per role below. `null` means "couldn't tell", in which case we still fail OPEN
    // (serve the unfiltered feed) rather than show an empty Notices tab — but that path is now
    // a genuine last resort, not the quiet default it used to be. See resolveOwnerJoinDate().
    let joinedAt: string | null = null;
    // Which source the cutoff came from, surfaced in the response so this is diagnosable in
    // production instead of guessable.
    let joinedAtSource = 'none';

    const runQuery = (filter: string[]) => {
      let query = supabaseAdminEngine
        .from('notices')
        .select('*')
        .or(filter.join(','));
      if (joinedAt) query = query.gte('created_at', joinedAt);
      return query.order('created_at', { ascending: false });
    };

    // 🎯 CONDITIONAL SECURITY FILTER ROUTER SWITCH
    if (tenantId) {
      // 🧑‍💻 TENANT SESSION ACTIVE: platform-wide admin bulletins, their OWN owner's broadcasts,
      // and notices addressed to them individually.
      console.log(`[NOTICE GATEWAY] Fetching notices framework for tenant runtime profile identity: ${tenantId}`);

      // Their owner, so an 'all_tenants' broadcast stays inside the building it was written for.
      // Previously this matched every 'all_tenants' row regardless of sender, so one owner's
      // announcement was readable by every other owner's tenants.
      const { data: tenantRow, error: tenantRowErr } = await supabaseAdminEngine
        .from('tenants').select('owner_id, created_at').eq('id', tenantId).maybeSingle();
      const theirOwnerId = tenantRow?.owner_id ?? null;
      // Onboarding date rides along on the row we already had to fetch — no extra round-trip.
      // A tenant's "signup" is when their owner onboarded them, which is exactly created_at:
      // notices sent between onboarding and their first login were still addressed to them.
      joinedAt = tenantRow?.created_at ?? null;
      joinedAtSource = joinedAt ? 'tenants.created_at' : 'unresolved';
      if (!joinedAt) {
        console.error(
          `[notices] no onboarding date for tenant ${tenantId} (${tenantRowErr?.message || 'row missing'}) — ` +
          `serving the UNFILTERED feed for this reader.`
        );
      }

      clauses = [
        'and(target_scope.eq.everyone,sender_type.eq.system_admin)',
        'and(target_scope.eq.all_tenants,sender_type.eq.system_admin)',
        `and(target_scope.eq.individual_tenant,target_tenant_id.eq.${tenantId})`,
      ];
      // Fail closed: with no resolvable owner, only the admin's platform bulletins are shown.
      if (theirOwnerId) {
        clauses.push(`and(target_scope.eq.all_tenants,sender_id.eq.${theirOwnerId})`);
      }
      dynamicTraceLogContext = "Tenant Personalized System Bulletins Feed";

    } else if (ownerId) {
      // 🏢 OWNER SESSION ACTIVE: notices issued BY them, plus admin bulletins addressed to all
      // owners, to everyone, or to this owner specifically.
      console.log(`[NOTICE GATEWAY] Fetching portfolio notices dashboard feed for owner runtime profile: ${ownerId}`);

      const resolved = await resolveOwnerJoinDate(ownerId);
      joinedAt = resolved.joinedAt;
      joinedAtSource = resolved.source;

      clauses = [
        `sender_id.eq.${ownerId}`,
        'target_scope.eq.all_owners',
        'target_scope.eq.everyone',
        `and(target_scope.eq.individual_owner,target_owner_id.eq.${ownerId})`,
      ];
      dynamicTraceLogContext = "Global Property Owner Bulletins Feed";
    }

    let { data: processedNotices, error: fetchDatabaseException } = await runQuery(clauses);

    // Pre-migration grace: ADD_NOTICE_TARGETS.sql adds notices.target_owner_id. Until it has
    // been run, referencing that column is a 42703 (undefined_column) — which would take the
    // whole Notices tab down for every owner. Retry without the individual-owner clause so the
    // feed keeps working, and say loudly what needs running.
    if (fetchDatabaseException?.code === '42703' && /target_owner_id/.test(fetchDatabaseException.message || '')) {
      console.error('[notices] notices.target_owner_id is missing — run ADD_NOTICE_TARGETS.sql. Serving the feed without owner-targeted notices.');
      ({ data: processedNotices, error: fetchDatabaseException } =
        await runQuery(clauses.filter((c) => !c.includes('target_owner_id'))));
    }

    if (fetchDatabaseException) {
      return apiError(request, fetchDatabaseException);
    }

    return NextResponse.json({
      success: true,
      scopingScope: dynamicTraceLogContext,
      // Where the "published after you joined" cutoff came from. `source: 'unresolved'` means
      // the feed was NOT trimmed — the one state in which a reader can see notices published
      // before their account existed. Reported rather than inferred, so it is diagnosable.
      joinedAt,
      joinedAtSource,
      count: processedNotices?.length || 0,
      data: processedNotices
    }, { status: 200 });

  } catch (runtimeExceptionCatch) {
    return apiError(request, runtimeExceptionCatch);
  }
}