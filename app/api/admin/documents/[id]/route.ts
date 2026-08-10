import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { supabaseAdminEngine } from '../../../../../lib/supabase-server';
import { assertOwnerCanWrite } from '../../../../../lib/subscription';
import { apiError } from '@/lib/api-response';

// ==============================================================================
// 🚀 DOCUMENT REMOVAL: owner deletes a tenant document record.
// ==============================================================================
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    if (!id) {
      return NextResponse.json({ error: 'Document identifier missing.' }, { status: 400 });
    }

    const guard = await assertOwnerCanWrite(
      request.headers.get('x-rentmaster-role'),
      request.headers.get('x-rentmaster-uid'),
    );
    if (!guard.ok) return NextResponse.json(guard.body, { status: guard.status });

    const { error } = await supabaseAdminEngine
      .from('documents')
      .delete()
      .eq('id', id);

    if (error) {
      return apiError(request, error);
    }

    return NextResponse.json({ success: true }, { status: 200 });
  } catch (e) {
    return apiError(request, e);
  }
}
