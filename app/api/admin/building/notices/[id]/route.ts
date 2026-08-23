import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { supabaseAdminEngine } from '@/lib/supabase-server';
import { assertOwnerCanWrite } from '@/lib/subscription';
import { apiError } from '@/lib/api-response';
import { requireBuildingAdmin } from '@/lib/building';

// =====================================================================================
// 🏢 BUILDING ADMIN — ONE NOTICE
// DELETE -> remove the printable record.
//
// The in-app copies already delivered are deliberately LEFT IN PLACE. They are in people's
// feeds and may already have been read; silently retracting them would make the app lie about
// what was published. This removes the building's own record only, and says so.
//
// There is no PATCH on purpose. A published notice with a reference number on it is a document,
// not a draft — correcting one means issuing another.
// =====================================================================================

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;

    const gate = await requireBuildingAdmin(request);
    if (!gate.ok) return NextResponse.json(gate.body, { status: gate.status });

    const guard = await assertOwnerCanWrite(request.headers.get('x-rentmaster-role'), gate.uid!);
    if (!guard.ok) return NextResponse.json(guard.body, { status: guard.status });

    const { data: notice } = await supabaseAdminEngine
      .from('building_notices')
      .select('id')
      .eq('id', id)
      .eq('building_id', gate.building!.id)
      .maybeSingle();
    if (!notice) {
      return NextResponse.json({ success: false, error: 'Notice not found.' }, { status: 404 });
    }

    const { error } = await supabaseAdminEngine
      .from('building_notices')
      .delete()
      .eq('id', id)
      .eq('building_id', gate.building!.id);
    if (error) throw error;

    return NextResponse.json(
      {
        success: true,
        message: 'Removed from your notice record. Copies already delivered stay in people’s feeds.',
      },
      { status: 200 }
    );
  } catch (err) {
    return apiError(request, err);
  }
}
