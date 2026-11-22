import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { supabaseAdminEngine } from '../../../../../../lib/supabase-server';
import { apiError } from '@/lib/api-response';
import { listClaims, normalizePayTo, EMPTY_PAY_TO } from '@/lib/payment-claims';

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
      return apiError(request, historyFetchDatabaseException);
    }

    // 4b. The landlord's pay-to details (read-only copy) and this tenant's open claims. Both are
    // best-effort extras: a missing table or an old account must not take the Rent tab down.
    let payTo = EMPTY_PAY_TO;
    const ownerIdFromLedger = tenantHistoryLedgerRecords?.[0]?.created_by_owner;
    if (ownerIdFromLedger) {
      try {
        const { data: owner } = await supabaseAdminEngine.auth.admin.getUserById(ownerIdFromLedger);
        payTo = normalizePayTo(((owner?.user?.user_metadata as any) || {}).rent_pay_to);
      } catch { /* keep the defaults */ }
    }
    let claimsByLedger: Record<string, any> = {};
    try {
      const claims = await listClaims({ payerId: targetTenantUuid, source: 'rent' });
      claimsByLedger = claims
        .filter((c) => c.status === 'pending')
        .reduce((acc: Record<string, any>, c) => {
          acc[String(c.ref_id)] = c;
          return acc;
        }, {});
    } catch { /* no claims table yet */ }
    const shaped = (tenantHistoryLedgerRecords || []).map((l: any) => ({
      ...l,
      claim: claimsByLedger[String(l.id)] || null,
    }));

    return NextResponse.json({
      success: true,
      scopingScope: "Isolated Single Tenant Historical Context Profile Logs",
      tenantId: targetTenantUuid,
      count: tenantHistoryLedgerRecords?.length || 0,
      payTo,
      data: shaped
    }, { status: 200 });

  } catch (runtimeExceptionCatch) {
    return apiError(request, runtimeExceptionCatch);
  }
}