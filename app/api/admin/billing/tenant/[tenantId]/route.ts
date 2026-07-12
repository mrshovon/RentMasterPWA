import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { supabaseAdminEngine } from '../../../../../../lib/supabase-server';

// ==============================================================================
// 🚀 TRACKER EXTRACTOR: ISOLATED SPECIFIC TENANT-WISE INVOICE BILLING HISTORY GET HANDLER
// ==============================================================================
export async function GET(request: NextRequest,{ params }: { params: Promise<{ tenantId: string }> }) 
{
  try {
    // 1. Resolve targeted identity tracking parameter identifier from segment route paths
    const { tenantId: targetTenantUuid } = await params;

    // 2. Authenticated identity: owner (uid) or tenant (tenant-id header).
    const ownerId = request.headers.get('x-rentmaster-uid');
    const callerTenantId = request.headers.get('x-rentmaster-tenant-id');

    if (!ownerId && !callerTenantId) {
      return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 });
    }
    if (!targetTenantUuid) {
      return NextResponse.json({ error: 'Segment route path parameters validation context missing target tenant token lookup criteria.' }, { status: 400 });
    }
    // IDOR guard: a tenant may only read THEIR OWN billing history.
    if (callerTenantId && callerTenantId !== targetTenantUuid) {
      return NextResponse.json({ error: 'You may only view your own billing history.' }, { status: 403 });
    }

    // 3. Query scoped to the caller: tenants → their own rows; owners → rows they created.
    let historyQuery = supabaseAdminEngine
      .from('billing_ledgers')
      .select(`
        *,
        properties:property_id (name ),
        tenants:tenant_id (name,phone )
      `)
      .eq('tenant_id', targetTenantUuid);
    if (!callerTenantId && ownerId) {
      historyQuery = historyQuery.eq('created_by_owner', ownerId);
    }
    const { data: tenantHistoryLedgerRecords, error: historyFetchDatabaseException } = await historyQuery
      .order('created_at', { ascending: false });

    if (historyFetchDatabaseException) {
      console.error('Supabase Isolated Tenant Ledger Query Failure Status Exception:', historyFetchDatabaseException);
      return NextResponse.json({ error: historyFetchDatabaseException.message }, { status: 500 });
    }

    // 4. Returning standalone single array context payload format values mapping back to interface tables grids
    return NextResponse.json({
      success: true,
      scopingScope: "Isolated Single Tenant Historical Context Profile Logs",
      tenantId: targetTenantUuid,
      count: tenantHistoryLedgerRecords?.length || 0,
      data: tenantHistoryLedgerRecords
    }, { status: 200 });

  } catch (runtimeExceptionCatch: any) {
    console.error('Fatal Pipeline Execution Standalone Tenant History Route Crash:', runtimeExceptionCatch);
    return NextResponse.json({ error: runtimeExceptionCatch.message || 'Fatal Server Logic Exception.' }, { status: 500 });
  }
}