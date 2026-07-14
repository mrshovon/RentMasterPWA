import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { supabaseAdminEngine } from '@/lib/supabase-server';

// =====================================================================================
// SUPPORT TICKETS — ADMIN QUEUE
// GET -> every owner's tickets, newest first, optionally filtered by ?status=
//
// middleware.ts already 403s any caller whose role is not 'admin' on /api/super-admin/*,
// so there is no auth code needed in here.
// =====================================================================================

const VALID_STATUS = ['submitted', 'assigned', 'in_progress', 'done'];

export async function GET(request: NextRequest) {
  try {
    const statusFilter = request.nextUrl.searchParams.get('status');

    let query = supabaseAdminEngine
      .from('support_tickets')
      .select('*')
      .order('created_at', { ascending: false });

    if (statusFilter && VALID_STATUS.includes(statusFilter)) {
      query = query.eq('status', statusFilter);
    }

    const { data: tickets, error } = await query;
    if (error) throw error;

    // Owners are Supabase auth users, not a table — enrich with one listUsers() call and
    // map by id, rather than a getUserById() per ticket.
    const { data: list } = await supabaseAdminEngine.auth.admin.listUsers({ page: 1, perPage: 1000 });
    const ownerById: Record<string, { name: string | null; email: string | null; phone: string | null }> = {};
    for (const u of list?.users || []) {
      const meta = (u.user_metadata as any) || {};
      ownerById[u.id] = {
        name: meta.name || null,
        email: u.email || null,
        phone: meta.phone || u.phone || null,
      };
    }

    const enriched = (tickets || []).map((t) => ({ ...t, owner: ownerById[t.owner_id] || null }));

    return NextResponse.json(
      { success: true, count: enriched.length, data: enriched },
      { status: 200 },
    );
  } catch (err: any) {
    console.error('Admin Support Tickets GET error:', err);
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}
