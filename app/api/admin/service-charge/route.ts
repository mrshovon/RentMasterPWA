import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { supabaseAdminEngine } from '../../../../lib/supabase-server';
import { assertOwnerCanWrite, resolveOwnerSubscription, assertItemEnabled } from '../../../../lib/subscription';

// =====================================================================================
// 🚀 SERVICE CHARGE BREAKDOWN ENGINE: per-property component breakdown of the monthly
// service charge (water, lift, security, etc.), stored in service_charge_breakdowns.
// =====================================================================================
const COMPONENTS = [
  'caretaker', 'common_electricity', 'common_gas',
  'dust_collectors', 'lift_maintenance', 'security_guard', 'water',
] as const;

const toNum = (v: unknown) => {
  const n = parseFloat(String(v ?? ''));
  return Number.isFinite(n) ? n : 0;
};

export async function GET(request: NextRequest) {
  try {
    const propertyId = request.nextUrl.searchParams.get('propertyId');
    if (!propertyId) {
      return NextResponse.json({ error: 'propertyId query parameter is required.' }, { status: 400 });
    }

    const { data, error } = await supabaseAdminEngine
      .from('service_charge_breakdowns')
      .select('*')
      .eq('property_id', propertyId)
      .maybeSingle();

    if (error) {
      console.error('Service Charge Fetch Error:', error);
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({ success: true, data: data || null }, { status: 200 });
  } catch (e: any) {
    console.error('Service Charge GET Route Crash:', e);
    return NextResponse.json({ error: e.message || 'Fatal Server Logic Exception.' }, { status: 500 });
  }
}

export async function PUT(request: NextRequest) {
  try {
    const role = request.headers.get('x-rentmaster-role');
    const ownerId = request.headers.get('x-rentmaster-uid');
    const guard = await assertOwnerCanWrite(role, ownerId);
    if (!guard.ok) return NextResponse.json(guard.body, { status: guard.status });

    const body = await request.json();
    const { propertyId } = body;
    if (!propertyId) {
      return NextResponse.json({ error: 'propertyId is required.' }, { status: 400 });
    }

    const sub = await resolveOwnerSubscription(ownerId || '');
    const itemGuard = await assertItemEnabled(role, ownerId, sub, { propertyId });
    if (!itemGuard.ok) return NextResponse.json(itemGuard.body, { status: itemGuard.status });

    const row: Record<string, any> = { property_id: propertyId, updated_at: new Date().toISOString() };
    for (const key of COMPONENTS) row[key] = toNum(body[key]);

    const { data, error } = await supabaseAdminEngine
      .from('service_charge_breakdowns')
      .upsert(row, { onConflict: 'property_id' })
      .select()
      .single();

    if (error) {
      console.error('Service Charge Upsert Error:', error);
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({ success: true, data }, { status: 200 });
  } catch (e: any) {
    console.error('Service Charge PUT Route Crash:', e);
    return NextResponse.json({ error: e.message || 'Fatal Server Logic Exception.' }, { status: 500 });
  }
}
