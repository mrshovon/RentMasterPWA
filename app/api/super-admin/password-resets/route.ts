import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { supabaseAdminEngine } from '@/lib/supabase-server';

// =====================================================================================
// PASSWORD RESET HISTORY — ADMIN-ONLY VIEW
// GET -> every owner password reset, newest first, optionally filtered by ?owner_id=.
//
// middleware.ts already 403s any caller whose role is not 'admin' on /api/super-admin/*,
// so no auth code is needed here. This is the ONLY read surface for password_reset_history.
// =====================================================================================

export async function GET(request: NextRequest) {
  try {
    const ownerFilter = request.nextUrl.searchParams.get('owner_id');

    let query = supabaseAdminEngine
      .from('password_reset_history')
      .select('*')
      .order('created_at', { ascending: false });

    if (ownerFilter) query = query.eq('owner_id', ownerFilter);

    const { data: rows, error } = await query;
    if (error) throw error;

    // Enrich owner + acting-admin with names/emails via a single listUsers() call.
    const { data: list } = await supabaseAdminEngine.auth.admin.listUsers({ page: 1, perPage: 1000 });
    const userById: Record<string, { name: string | null; email: string | null }> = {};
    for (const u of list?.users || []) {
      const meta = (u.user_metadata as any) || {};
      userById[u.id] = { name: meta.name || null, email: u.email || null };
    }

    const enriched = (rows || []).map((r) => ({
      ...r,
      owner: userById[r.owner_id] || { name: null, email: r.owner_email || null },
      actor: r.reset_by ? userById[r.reset_by] || null : null,
    }));

    return NextResponse.json({ success: true, count: enriched.length, data: enriched }, { status: 200 });
  } catch (err: any) {
    console.error('Admin Password Resets GET error:', err);
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}
