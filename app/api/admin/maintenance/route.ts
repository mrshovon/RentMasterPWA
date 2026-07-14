import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { supabaseAdminEngine } from '../../../../lib/supabase-server';
import { assertOwnerCanWrite } from '../../../../lib/subscription';
import { sendPushToUsers } from '../../../../lib/push-send';
import crypto from 'crypto';

// =====================================================================================
// 🚀 MAINTENANCE MAINTENANCE REGISTER ENGINE: ISSUE DISPATCH ENTRY CONTROLLER ROUTE LAYER
// =====================================================================================
export async function POST(request: NextRequest) {
  try {
    // 1. Resolve secure active user token identifier configuration fallback matrix
    const ownerId = request.headers.get('x-rentmaster-uid');
    const tenantHeaderId = request.headers.get('x-rentmaster-tenant-id');
    const role = request.headers.get('x-rentmaster-role');

    // Either an owner (uid) or a tenant (tenant-id) may file a ticket.
    if (!ownerId && !tenantHeaderId) {
      return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 });
    }

    // Owner write-lock (tenants filing tickets use role 'tenant' and pass through).
    const guard = await assertOwnerCanWrite(role, ownerId);
    if (!guard.ok) return NextResponse.json(guard.body, { status: guard.status });

    // 2. Parsed payload configuration arrays variables
    const bodyPayload = await request.json();
    const {
      propertyId,
      tenantId,
      issueTitle,
      issueDescription,
      priorityLevel,
      attachmentFileUrl,   // legacy single-file field (kept for backward compatibility)
      attachmentFileUrls,  // 🚀 array of storage URLs dispatched from multi-file frontend uploads
      estimatedCost
    } = bodyPayload;

    if (!propertyId || !issueTitle) {
      return NextResponse.json({ error: 'Compulsory validation tracking parameters boundary definitions properties missing.' }, { status: 400 });
    }

    // Normalise attachments into the single text column: one plain URL stays a plain
    // string; multiple URLs are JSON-encoded (the frontend parser handles both shapes).
    const attachmentUrlList: string[] = (
      Array.isArray(attachmentFileUrls) ? attachmentFileUrls : attachmentFileUrl ? [attachmentFileUrl] : []
    ).filter((u: unknown): u is string => typeof u === 'string' && u.trim() !== '');
    const attachmentValue =
      attachmentUrlList.length === 0 ? null
      : attachmentUrlList.length === 1 ? attachmentUrlList[0]
      : JSON.stringify(attachmentUrlList);

    const logIdentityId = crypto.randomUUID();
    const costValue = estimatedCost ? parseFloat(estimatedCost) : 0.00;

    // 3. Database operations mutation record insert logic pipeline
    const { data: maintenanceLogRecord, error: databaseInsertLogException } = await supabaseAdminEngine
      .from('maintenance_logs')
      .insert([
        {
          id: logIdentityId,
          property_id: propertyId,
          tenant_id: tenantId || null,
          issue_title: issueTitle,
          issue_description: issueDescription || null,
          priority_level: priorityLevel || 'medium',
          resolution_status: 'reported', // Always defaults tracking lifecycle sequence towards 'reported'
          attachment_file_url: attachmentValue,
          estimated_cost: costValue
        }
      ])
      // Embed the owning property so we know whose device to buzz (mirrors the GET).
      .select('*, properties:property_id ( name, flat_no, owner_id )')
      .single();

    if (databaseInsertLogException) {
      console.error('Supabase Maintenance Execution Logging Registry Failure:', databaseInsertLogException);
      return NextResponse.json({ error: databaseInsertLogException.message }, { status: 500 });
    }

    // 3b. A tenant filed the ticket — buzz the property's owner. (When the owner files it
    // themselves there is nobody to notify.) Fire-and-forget: never fail the response.
    const propertyOwnerId = (maintenanceLogRecord as any)?.properties?.owner_id;
    if (tenantHeaderId && propertyOwnerId) {
      const unitLabel = (maintenanceLogRecord as any)?.properties?.name || 'a property';
      try {
        await sendPushToUsers([propertyOwnerId], {
          title: `New ${priorityLevel || 'medium'}-priority request`,
          body: `${issueTitle} — ${unitLabel}`,
          url: '/owner',
          tag: `maintenance-${logIdentityId}`,
        });
      } catch (pushErr) {
        console.error('[maintenance] push dispatch failed (non-fatal):', pushErr);
      }
    }

    // 4. Send success verification logs response back to UI interface component grids
    return NextResponse.json({ 
      success: true, 
      message: 'Maintenance dynamic logs incident report recorded cleanly inside backend storage mappings.',
      data: maintenanceLogRecord 
    }, { status: 201 });

  } catch (runtimeExceptionCatch: any) {
    console.error('Fatal Pipeline Execution Maintenance Core POST Route Crash:', runtimeExceptionCatch);
    return NextResponse.json({ error: runtimeExceptionCatch.message || 'Fatal Server Logic Exception.' }, { status: 500 });
  }
}

// =====================================================================================
// 🚀 MAINTENANCE STREAM ENGINE: GLOBAL ADAPTIVE PORTFOLIO LOGS QUERY GET HANDLER
// =====================================================================================
export async function GET(request: NextRequest) {
  try {
    // 1. Resolve authentication identities signature tokens from headers
    const ownerId = request.headers.get('x-rentmaster-uid');
    const tenantId = request.headers.get('x-rentmaster-tenant-id'); 

    if (!ownerId && !tenantId) {
      return NextResponse.json({ error: 'Identity resolution contexts parsing criteria failed.' }, { status: 400 });
    }

    // 🚀 UPDATED SELECTION: Pulling owner_id column from properties table relation cleanly
    let queryMatrixSelector = supabaseAdminEngine
      .from('maintenance_logs')
      .select(`
        id,
        property_id,
        tenant_id,
        issue_title,
        issue_description,
        priority_level,
        resolution_status,
        resolution_remarks,
        attachment_file_url,
        estimated_cost,
        created_at,
        properties:property_id ( name, owner_id ),
        tenants:tenant_id ( name, phone )
      `);

    let executionScopingTrace = "";

    // 🎯 2. ROUTING LOGIC APPLICATION AND SWITCH LAYER
    if (tenantId) {
      console.log(`[MAINTENANCE GATEWAY] Querying isolated tickets for active Tenant: ${tenantId}`);
      queryMatrixSelector = queryMatrixSelector.eq('tenant_id', tenantId);
      executionScopingTrace = "Tenant Private Incident Matrix Logs";
      
    } else if (ownerId) {
      console.log(`[MAINTENANCE GATEWAY] Querying full global database records to isolate portfolio for Owner: ${ownerId}`);
      executionScopingTrace = "Global Portfolio Owner Monitor Grid Panel";
    }

    // 3. Fire clean extraction query criteria matrices inside database clusters
    const { data: rawMaintenanceRecords, error: historyFetchDatabaseException } = await queryMatrixSelector
      .order('created_at', { ascending: false });

    if (historyFetchDatabaseException) {
      console.error('Supabase Core Multi-Scoping Maintenance Log Query Breakdown Error:', historyFetchDatabaseException);
      return NextResponse.json({ error: historyFetchDatabaseException.message }, { status: 500 });
    }

    // 🚀 4. ACCURATE IN-MEMORY FILTERING MATCHING RE-ALIGNED TO 'owner_id' COLUMN
    const filteredPayloadRecords = rawMaintenanceRecords?.filter(rowEntry => {
      if (ownerId && !tenantId) {
        const propertyNode = rowEntry.properties as any;
        // 🎯 EXACT BINDING MATCHING: Re-aligned variable lookup to match owner_id
        return propertyNode && propertyNode.owner_id === ownerId;
      }
      return true;
    }) || [];

    // 5. Stream results safely back to customer frontend component frameworks grids
    return NextResponse.json({
      success: true,
      scopingScope: executionScopingTrace,
      count: filteredPayloadRecords.length,
      data: filteredPayloadRecords
    }, { status: 200 });

  } catch (runtimeExceptionCatch: any) {
    console.error('Fatal Pipeline Execution Maintenance Adaptive GET Route Crash:', runtimeExceptionCatch);
    return NextResponse.json({ error: runtimeExceptionCatch.message || 'Fatal Server Logic Exception.' }, { status: 500 });
  }
}