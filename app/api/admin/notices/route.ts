import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { supabaseAdminEngine } from '../../../../lib/supabase-server';
import { assertOwnerCanWrite } from '../../../../lib/subscription';
import { sendPushToUsers, sendPushToRole } from '../../../../lib/push-send';
import crypto from 'crypto';

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
      targetScope, // 'all_tenants', 'individual_tenant', or 'all_owners'
      targetTenantId, 
      title, 
      content 
    } = bodyPayload;

    // Boundary Validation Constraints Checks
    if (!senderType || !targetScope || !title || !content) {
      return NextResponse.json({ error: 'Compulsory payload fields matching validation constraints missing.' }, { status: 400 });
    }

    if (targetScope === 'individual_tenant' && !targetTenantId) {
      return NextResponse.json({ error: 'Target tenant ID must be provided when scope is mapped to an individual.' }, { status: 400 });
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
      } else if (targetScope === 'all_tenants') {
        await sendPushToRole('tenant', { ...pushPayload, url: '/tenant' });
      } else if (targetScope === 'all_owners') {
        await sendPushToRole('owner', { ...pushPayload, url: '/owner' });
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

    let queryMatrixSelector = supabaseAdminEngine.from('notices').select('*');
    let dynamicTraceLogContext = "";

    // 🎯 CONDITIONAL SECURITY FILTER ROUTER SWITCH
    if (tenantId) {
      // 🧑‍💻 TENANT SESSION ACTIVE: Must fetch notices targetted to ALL tenants or specifically them
      console.log(`[NOTICE GATEWAY] Fetching notices framework for tenant runtime profile identity: ${tenantId}`);
      queryMatrixSelector = queryMatrixSelector.or(`target_scope.eq.all_tenants,and(target_scope.eq.individual_tenant,target_tenant_id.eq.${tenantId})`);
      dynamicTraceLogContext = "Tenant Personalized System Bulletins Feed";

    } else if (ownerId) {
      // 🏢 OWNER SESSION ACTIVE: Must pull notices issued BY them, or system wide bulletins issued to ALL owners by admin
      console.log(`[NOTICE GATEWAY] Fetching portfolio notices dashboard feed for owner runtime profile: ${ownerId}`);
      queryMatrixSelector = queryMatrixSelector.or(`sender_id.eq.${ownerId},target_scope.eq.all_owners`);
      dynamicTraceLogContext = "Global Property Owner Bulletins Feed";
    }

    const { data: processedNotices, error: fetchDatabaseException } = await queryMatrixSelector
      .order('created_at', { ascending: false });

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