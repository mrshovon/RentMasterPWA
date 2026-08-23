import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { supabaseAdminEngine } from '@/lib/supabase-server';
import { assertOwnerCanWrite } from '@/lib/subscription';
import { apiError } from '@/lib/api-response';
import { requireBuildingAdmin } from '@/lib/building';
import {
  AMENITY_SELECT, amenityFieldsFrom, ownedBuildingExtra, BuildingExtraFieldError,
} from '@/lib/building-extras';

// =====================================================================================
// 🏢 BUILDING ADMIN — ONE AMENITY
// PATCH  -> edit it (partial; only the keys sent are written).
// DELETE -> remove it. Safe to do freely: nothing references an amenity, it is a label.
// =====================================================================================

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;

    const gate = await requireBuildingAdmin(request);
    if (!gate.ok) return NextResponse.json(gate.body, { status: gate.status });

    const guard = await assertOwnerCanWrite(request.headers.get('x-rentmaster-role'), gate.uid!);
    if (!guard.ok) return NextResponse.json(guard.body, { status: guard.status });

    if (!(await ownedBuildingExtra('building_amenities', id, gate.building!.id))) {
      return NextResponse.json({ success: false, error: 'Amenity not found.' }, { status: 404 });
    }

    let fields: Record<string, unknown>;
    try {
      fields = amenityFieldsFrom(await request.json());
    } catch (e) {
      if (e instanceof BuildingExtraFieldError) {
        return NextResponse.json({ success: false, error: e.message }, { status: 400 });
      }
      throw e;
    }
    if (!Object.keys(fields).length) {
      return NextResponse.json({ success: false, error: 'Nothing to update.' }, { status: 400 });
    }

    const { data, error } = await supabaseAdminEngine
      .from('building_amenities')
      .update(fields)
      .eq('id', id)
      .eq('building_id', gate.building!.id)
      .select(AMENITY_SELECT)
      .single();
    if (error) throw error;

    return NextResponse.json({ success: true, data }, { status: 200 });
  } catch (err) {
    return apiError(request, err);
  }
}

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;

    const gate = await requireBuildingAdmin(request);
    if (!gate.ok) return NextResponse.json(gate.body, { status: gate.status });

    const guard = await assertOwnerCanWrite(request.headers.get('x-rentmaster-role'), gate.uid!);
    if (!guard.ok) return NextResponse.json(guard.body, { status: guard.status });

    if (!(await ownedBuildingExtra('building_amenities', id, gate.building!.id))) {
      return NextResponse.json({ success: false, error: 'Amenity not found.' }, { status: 404 });
    }

    const { error } = await supabaseAdminEngine
      .from('building_amenities')
      .delete()
      .eq('id', id)
      .eq('building_id', gate.building!.id);
    if (error) throw error;

    return NextResponse.json({ success: true }, { status: 200 });
  } catch (err) {
    return apiError(request, err);
  }
}
