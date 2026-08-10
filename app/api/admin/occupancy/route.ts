import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { supabaseAdminEngine } from '../../../../lib/supabase-server';
import { apiError } from '@/lib/api-response';

// =====================================================================================
// 🚀 OCCUPANCY HISTORY: past tenants archived for a property (written on vacate).
// GET /api/admin/occupancy?propertyId=UNIT-1234
// =====================================================================================
export async function GET(request: NextRequest) {
  try {
    const propertyId = request.nextUrl.searchParams.get('propertyId');
    if (!propertyId) {
      return NextResponse.json({ error: 'propertyId query parameter is required.' }, { status: 400 });
    }

    const { data, error } = await supabaseAdminEngine
      .from('property_occupancy_history')
      .select('*')
      .eq('property_id', propertyId)
      .order('archived_at', { ascending: false });

    if (error) {
      return apiError(request, error);
    }

    return NextResponse.json({ success: true, count: data?.length || 0, data }, { status: 200 });
  } catch (e) {
    return apiError(request, e);
  }
}
