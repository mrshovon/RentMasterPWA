import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { supabaseAdminEngine } from '@/lib/supabase-server';

// =====================================================================================
// CONTACT MESSAGES — ADMIN QUEUE
// GET -> every owner's contact enquiry, newest first, optionally filtered by ?status=.
//
// middleware.ts already 403s any caller whose role is not 'admin' on /api/super-admin/*,
// so no auth code is needed here.
// =====================================================================================

const VALID_STATUS = ['new', 'in_progress', 'resolved', 'archived'];

export async function GET(request: NextRequest) {
  try {
    const statusFilter = request.nextUrl.searchParams.get('status');

    let query = supabaseAdminEngine
      .from('contact_messages')
      .select('*')
      .order('created_at', { ascending: false });

    if (statusFilter && VALID_STATUS.includes(statusFilter)) {
      query = query.eq('status', statusFilter);
    }

    const { data: messages, error } = await query;
    if (error) throw error;

    // Enrich with the owner's account name/email via a single listUsers() call.
    const { data: list } = await supabaseAdminEngine.auth.admin.listUsers({ page: 1, perPage: 1000 });
    const ownerById: Record<string, { name: string | null; email: string | null; phone: string | null }> = {};
    for (const u of list?.users || []) {
      const meta = (u.user_metadata as any) || {};
      ownerById[u.id] = { name: meta.name || null, email: u.email || null, phone: meta.phone || u.phone || null };
    }

    const enriched = (messages || []).map((m) => ({ ...m, owner: ownerById[m.owner_id] || null }));

    return NextResponse.json({ success: true, count: enriched.length, data: enriched }, { status: 200 });
  } catch (err: any) {
    console.error('Admin Contact Messages GET error:', err);
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}
