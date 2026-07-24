import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { supabaseAdminEngine } from '../../../../lib/supabase-server';
import { assertOwnerCanWrite } from '../../../../lib/subscription';
import { sendPushToUsers, sendPushToRole } from '../../../../lib/push-send';
import crypto from 'crypto';

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
      console.error('Supabase Notice Injection Database Failure Error:', databaseInsertException);
      return NextResponse.json({ error: databaseInsertException.message }, { status: 500 });
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

  } catch (runtimeExceptionCatch: any) {
    console.error('Fatal Pipeline Execution Notices Core POST Route Crash:', runtimeExceptionCatch);
    return NextResponse.json({ error: runtimeExceptionCatch.message || 'Fatal Server Logic Exception.' }, { status: 500 });
  }
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

    const runQuery = (filter: string[]) =>
      supabaseAdminEngine
        .from('notices')
        .select('*')
        .or(filter.join(','))
        .order('created_at', { ascending: false });

    // 🎯 CONDITIONAL SECURITY FILTER ROUTER SWITCH
    if (tenantId) {
      // 🧑‍💻 TENANT SESSION ACTIVE: platform-wide admin bulletins, their OWN owner's broadcasts,
      // and notices addressed to them individually.
      console.log(`[NOTICE GATEWAY] Fetching notices framework for tenant runtime profile identity: ${tenantId}`);

      // Their owner, so an 'all_tenants' broadcast stays inside the building it was written for.
      // Previously this matched every 'all_tenants' row regardless of sender, so one owner's
      // announcement was readable by every other owner's tenants.
      const { data: tenantRow } = await supabaseAdminEngine
        .from('tenants').select('owner_id').eq('id', tenantId).maybeSingle();
      const theirOwnerId = tenantRow?.owner_id ?? null;

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
      console.error('Supabase Notice Framework Stream Failure Error Exception:', fetchDatabaseException);
      return NextResponse.json({ error: fetchDatabaseException.message }, { status: 500 });
    }

    return NextResponse.json({
      success: true,
      scopingScope: dynamicTraceLogContext,
      count: processedNotices?.length || 0,
      data: processedNotices
    }, { status: 200 });

  } catch (runtimeExceptionCatch: any) {
    console.error('Fatal Pipeline Execution Notices Core GET Route Crash:', runtimeExceptionCatch);
    return NextResponse.json({ error: runtimeExceptionCatch.message || 'Fatal Server Logic Exception.' }, { status: 500 });
  }
}