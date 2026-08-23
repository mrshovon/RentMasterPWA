import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { supabaseAdminEngine } from '@/lib/supabase-server';
import { assertOwnerCanWrite } from '@/lib/subscription';
import { apiError } from '@/lib/api-response';
import {
  requireBuildingAdmin,
  buildingFieldsFrom,
  BuildingFieldError,
  countActiveBuildingOwners,
  BUILDING_SELECT,
} from '@/lib/building';

// =====================================================================================
// 🏢 BUILDING ADMIN — MY BUILDING
// GET   -> the building this admin runs, plus its owner count.
// PATCH -> edit its details (name, address, letterhead, signatory).
//
// Lives under /api/admin/ so middleware injects and verifies identity — but note that
// middleware enforces a ROLE only for /api/super-admin/, so requireBuildingAdmin() is what
// actually keeps owners and tenants out. It is the first line of every handler here.
// =====================================================================================

export async function GET(request: NextRequest) {
  try {
    const gate = await requireBuildingAdmin(request);
    if (!gate.ok) return NextResponse.json(gate.body, { status: gate.status });

    const ownerCount = await countActiveBuildingOwners(gate.building!.id);

    return NextResponse.json(
      { success: true, data: { ...gate.building!, owner_count: ownerCount } },
      { status: 200 }
    );
  } catch (err) {
    return apiError(request, err);
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const gate = await requireBuildingAdmin(request);
    if (!gate.ok) return NextResponse.json(gate.body, { status: gate.status });

    const guard = await assertOwnerCanWrite(request.headers.get('x-rentmaster-role'), gate.uid!);
    if (!guard.ok) return NextResponse.json(guard.body, { status: guard.status });

    let fields: Record<string, unknown>;
    try {
      fields = buildingFieldsFrom(await request.json());
    } catch (e) {
      if (e instanceof BuildingFieldError) {
        return NextResponse.json({ success: false, error: e.message }, { status: 400 });
      }
      throw e;
    }
    if (!Object.keys(fields).length) {
      return NextResponse.json({ success: false, error: 'Nothing to update.' }, { status: 400 });
    }

    const { data, error } = await supabaseAdminEngine
      .from('buildings')
      .update(fields)
      .eq('id', gate.building!.id)
      .select(BUILDING_SELECT)
      .single();
    if (error) throw error;

    return NextResponse.json({ success: true, data }, { status: 200 });
  } catch (err) {
    return apiError(request, err);
  }
}
