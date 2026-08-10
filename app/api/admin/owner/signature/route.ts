import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { supabaseAdminEngine } from '../../../../../lib/supabase-server';
import { assertOwnerCanWrite } from '../../../../../lib/subscription';
import { apiError } from '@/lib/api-response';

// =====================================================================================
// 🚀 OWNER SIGNATURE: stored on the owner's Supabase auth user_metadata (no table needed).
// GET  -> { signatureUrl }
// POST { signatureUrl } -> saves it (merged into existing metadata)
// =====================================================================================
export async function GET(request: NextRequest) {
  try {
    const ownerId = request.headers.get('x-rentmaster-uid');
    if (!ownerId) return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 });
    const { data, error } = await supabaseAdminEngine.auth.admin.getUserById(ownerId);
    if (error) return apiError(request, error);
    const signatureUrl = (data?.user?.user_metadata as any)?.signature_url ?? null;
    return NextResponse.json({ success: true, signatureUrl }, { status: 200 });
  } catch (e) {
    return apiError(request, e);
  }
}

export async function POST(request: NextRequest) {
  try {
    const ownerId = request.headers.get('x-rentmaster-uid');
    if (!ownerId) return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 });
    const guard = await assertOwnerCanWrite(request.headers.get('x-rentmaster-role'), ownerId);
    if (!guard.ok) return NextResponse.json(guard.body, { status: guard.status });

    const { signatureUrl } = await request.json();
    if (!signatureUrl) {
      return NextResponse.json({ error: 'signatureUrl is required.' }, { status: 400 });
    }

    // Preserve existing metadata (name, phone, role) while setting the signature.
    const { data: current } = await supabaseAdminEngine.auth.admin.getUserById(ownerId);
    const meta = { ...((current?.user?.user_metadata as any) || {}), signature_url: signatureUrl };

    const { error } = await supabaseAdminEngine.auth.admin.updateUserById(ownerId, { user_metadata: meta });
    if (error) return apiError(request, error);

    return NextResponse.json({ success: true, signatureUrl }, { status: 200 });
  } catch (e) {
    return apiError(request, e);
  }
}
