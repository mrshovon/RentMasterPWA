import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { supabaseAdminEngine } from '../../../../lib/supabase-server';
import { assertOwnerCanWrite, resolveOwnerSubscription, assertItemEnabled } from '../../../../lib/subscription';
import { apiError } from '@/lib/api-response';

// =====================================================================================
// 🚀 DOCUMENTS ENGINE: per-tenant documents (deeds, agreements) uploaded by the owner
// and surfaced to that specific tenant. (Requires the `documents` table migration.)
// =====================================================================================

// GET — a tenant sees only their own docs (via header); the owner lists a tenant's docs (?tenantId=).
export async function GET(request: NextRequest) {
  try {
    const headerTenant = request.headers.get('x-rentmaster-tenant-id');
    const queryTenant = request.nextUrl.searchParams.get('tenantId');
    const tenantId = headerTenant || queryTenant; // header wins → tenant locked to own docs

    if (!tenantId) {
      return NextResponse.json({ error: 'tenantId is required (query param or tenant session).' }, { status: 400 });
    }

    const { data, error } = await supabaseAdminEngine
      .from('documents')
      .select('*')
      .eq('tenant_id', tenantId)
      .order('created_at', { ascending: false });

    if (error) {
      return apiError(request, error);
    }

    return NextResponse.json({ success: true, count: data?.length || 0, data }, { status: 200 });
  } catch (e) {
    return apiError(request, e);
  }
}

// POST — owner attaches a document (already uploaded to storage) to a tenant.
export async function POST(request: NextRequest) {
  try {
    const ownerId = request.headers.get('x-rentmaster-uid');
    const role = request.headers.get('x-rentmaster-role');
    if (!ownerId) return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 });
    const body = await request.json();
    const { tenantId, title, docType, fileUrl } = body;

    if (!tenantId || !title || !fileUrl) {
      return NextResponse.json({ error: 'tenantId, title and fileUrl are required.' }, { status: 400 });
    }

    const guard = await assertOwnerCanWrite(role, ownerId);
    if (!guard.ok) return NextResponse.json(guard.body, { status: guard.status });

    const sub = await resolveOwnerSubscription(ownerId);
    const itemGuard = await assertItemEnabled(role, ownerId, sub, { tenantId });
    if (!itemGuard.ok) return NextResponse.json(itemGuard.body, { status: itemGuard.status });

    const { data, error } = await supabaseAdminEngine
      .from('documents')
      .insert([
        {
          tenant_id: tenantId,
          title,
          doc_type: docType || null,
          file_url: fileUrl,
          uploaded_by: ownerId,
        },
      ])
      .select()
      .single();

    if (error) {
      return apiError(request, error);
    }

    return NextResponse.json({ success: true, data }, { status: 201 });
  } catch (e) {
    return apiError(request, e);
  }
}
