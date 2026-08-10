import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { supabaseAdminEngine } from '../../../../lib/supabase-server';
import { apiError } from '@/lib/api-response';

// =====================================================================================
// 🚀 RENT REVISION ARCHIVE: audit trail of every rent change for a tenant.
// Owner: GET /api/admin/rent-revisions?tenantId=<id>
// Tenant: GET /api/admin/rent-revisions  (scoped to their own via x-rentmaster-tenant-id)
// =====================================================================================
export async function GET(request: NextRequest) {
  try {
    const headerTenant = request.headers.get('x-rentmaster-tenant-id');
    const queryTenant = request.nextUrl.searchParams.get('tenantId');
    const tenantId = headerTenant || queryTenant; // header wins → tenant locked to own history

    if (!tenantId) {
      return NextResponse.json({ error: 'tenantId is required (query param or tenant session).' }, { status: 400 });
    }

    const { data, error } = await supabaseAdminEngine
      .from('rent_revision_archives')
      .select('*')
      .eq('tenant_id', tenantId)
      .order('changed_at', { ascending: false });

    if (error) {
      return apiError(request, error);
    }

    return NextResponse.json({ success: true, count: data?.length || 0, data }, { status: 200 });
  } catch (e) {
    return apiError(request, e);
  }
}
