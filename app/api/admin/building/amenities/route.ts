import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { supabaseAdminEngine } from '@/lib/supabase-server';
import { assertOwnerCanWrite } from '@/lib/subscription';
import { apiError } from '@/lib/api-response';
import { requireBuildingAdmin } from '@/lib/building';
import { AMENITY_SELECT, amenityFieldsFrom, BuildingExtraFieldError } from '@/lib/building-extras';

// =====================================================================================
// 🏢 BUILDING ADMIN — AMENITIES
// GET  -> what this building runs and what each costs per month.
// POST -> add one.
//
// A definitions list, not a ledger: nothing here is a balance and nothing derives from it.
// See ADD_BUILDING_EXTRAS.sql.
// =====================================================================================

export async function GET(request: NextRequest) {
  try {
    const gate = await requireBuildingAdmin(request);
    if (!gate.ok) return NextResponse.json(gate.body, { status: gate.status });

    const { data, error } = await supabaseAdminEngine
      .from('building_amenities')
      .select(AMENITY_SELECT)
      .eq('building_id', gate.building!.id)
      .order('created_at', { ascending: true });
    if (error) throw error;

    return NextResponse.json({ success: true, count: data?.length || 0, data: data || [] }, { status: 200 });
  } catch (err) {
    return apiError(request, err);
  }
}

export async function POST(request: NextRequest) {
  try {
    const gate = await requireBuildingAdmin(request);
    if (!gate.ok) return NextResponse.json(gate.body, { status: gate.status });

    const guard = await assertOwnerCanWrite(request.headers.get('x-rentmaster-role'), gate.uid!);
    if (!guard.ok) return NextResponse.json(guard.body, { status: guard.status });

    let fields: Record<string, unknown>;
    try {
      fields = amenityFieldsFrom(await request.json(), true);
    } catch (e) {
      if (e instanceof BuildingExtraFieldError) {
        return NextResponse.json({ success: false, error: e.message }, { status: 400 });
      }
      throw e;
    }

    const { data, error } = await supabaseAdminEngine
      .from('building_amenities')
      .insert({ id: crypto.randomUUID(), building_id: gate.building!.id, ...fields })
      .select(AMENITY_SELECT)
      .single();
    if (error) throw error;

    return NextResponse.json({ success: true, data }, { status: 201 });
  } catch (err) {
    return apiError(request, err);
  }
}
