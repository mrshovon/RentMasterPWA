import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { supabaseAdminEngine } from '@/lib/supabase-server';

// =====================================================================================
// PAYMENT SUBMISSIONS — ADMIN QUEUE
// GET -> every owner's payment submissions, newest first, optionally filtered by ?status=
//
// middleware.ts already 403s any caller whose role is not 'admin' on /api/super-admin/*,
// so there is no auth code needed in here.
// =====================================================================================

const VALID_STATUS = ['pending', 'approved', 'rejected'];

export async function GET(request: NextRequest) {
  try {
    const statusFilter = request.nextUrl.searchParams.get('status');

    let query = supabaseAdminEngine
      .from('payment_submissions')
      .select('*')
      .order('created_at', { ascending: false });

    if (statusFilter && VALID_STATUS.includes(statusFilter)) {
      query = query.eq('status', statusFilter);
    }

    const { data: rows, error } = await query;
    if (error) throw error;

    // Owners are Supabase auth users, not a table — enrich with one listUsers() call and
    // map by id, rather than a getUserById() per row. Also fetch tier names in one query.
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

    const { data: tiers } = await supabaseAdminEngine.from('subscription_tiers').select('id, name');
    const tierNameById: Record<string, string> = {};
    for (const t of tiers || []) tierNameById[t.id] = t.name;

    const enriched = (rows || []).map((r) => ({
      ...r,
      owner: ownerById[r.owner_id] || null,
      tier_name: tierNameById[r.tier_id] || r.tier_id,
    }));

    return NextResponse.json({ success: true, count: enriched.length, data: enriched }, { status: 200 });
  } catch (err: any) {
    console.error('Admin Payments GET error:', err);
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}
