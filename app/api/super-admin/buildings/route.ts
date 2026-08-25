import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { supabaseAdminEngine } from '@/lib/supabase-server';
import { apiError } from '@/lib/api-response';
import { BUILDING_SELECT } from '@/lib/building';
import { buildingPlanState, planBalanceOf } from '@/lib/building-plan';

// =====================================================================================
// 👑 SUPER ADMIN — BUILDINGS
// GET -> every building with its contract state, owner count, money owed and open requests.
//        This is the data behind the console's Buildings menu.
//
// No auth code here on purpose: middleware.ts gates every /api/super-admin/* path on
// user_metadata.role === 'admin' and returns 403 before a handler ever runs.
//
// One query per table and a single listUsers() call rather than N per building — the same shape
// the Payments and Messages queues use, and the reason those stay fast with a full queue.
// =====================================================================================

export async function GET(request: NextRequest) {
  try {
    const { data: buildings, error } = await supabaseAdminEngine
      .from('buildings')
      .select(BUILDING_SELECT)
      .order('created_at', { ascending: false });
    if (error) throw error;

    const rows = buildings || [];
    if (!rows.length) {
      return NextResponse.json({ success: true, count: 0, data: [] }, { status: 200 });
    }
    const ids = rows.map((b: any) => b.id);

    // Every lookup below is independently tolerant: a building whose contract row is missing
    // still lists, it just reads as "no contract". Before ADD_BUILDING_PLANS.sql has run that is
    // every building, and the menu is still usable rather than being a 500.
    const [subsRes, ownersRes, invoicesRes, requestsRes, usersRes] = await Promise.all([
      supabaseAdminEngine.from('building_subscriptions').select('*').in('building_id', ids),
      supabaseAdminEngine.from('building_owners').select('building_id, is_active').in('building_id', ids),
      supabaseAdminEngine
        .from('building_plan_invoices')
        .select('id, building_id, total_payable, amount_paid, payment_status, status, due_on, created_at')
        .in('building_id', ids),
      supabaseAdminEngine
        .from('building_plan_requests')
        .select('id, building_id, kind, status, created_at')
        .in('building_id', ids)
        .in('status', ['new', 'in_progress', 'quoted']),
      supabaseAdminEngine.auth.admin.listUsers({ page: 1, perPage: 1000 }),
    ]);

    const subByBuilding = new Map<string, any>();
    (subsRes.data || []).forEach((s: any) => subByBuilding.set(s.building_id, s));

    const ownerCount = new Map<string, number>();
    (ownersRes.data || []).forEach((o: any) => {
      if (o.is_active === false) return;
      ownerCount.set(o.building_id, (ownerCount.get(o.building_id) || 0) + 1);
    });

    const owedByBuilding = new Map<string, number>();
    (invoicesRes.data || []).forEach((inv: any) => {
      if (inv.status === 'void' || inv.status === 'draft') return;
      owedByBuilding.set(inv.building_id, (owedByBuilding.get(inv.building_id) || 0) + planBalanceOf(inv));
    });

    const openRequests = new Map<string, number>();
    (requestsRes.data || []).forEach((r: any) => {
      openRequests.set(r.building_id, (openRequests.get(r.building_id) || 0) + 1);
    });

    const userById = new Map<string, any>();
    (usersRes.data?.users || []).forEach((u: any) => userById.set(u.id, u));

    const data = rows.map((b: any) => {
      const sub = subByBuilding.get(b.id) || null;
      const admin = userById.get(b.admin_id);
      return {
        ...b,
        owner_count: ownerCount.get(b.id) || 0,
        amount_owed: owedByBuilding.get(b.id) || 0,
        open_requests: openRequests.get(b.id) || 0,
        // The generated identifier is how a building admin signs in — there is no inbox behind it,
        // so it is the only handle we have for them and it belongs in the listing.
        admin_login: admin?.email || null,
        admin_name: admin?.user_metadata?.name || null,
        admin_phone: admin?.user_metadata?.phone || null,
        subscription: sub,
        state: sub ? buildingPlanState(sub) : null,
      };
    });

    return NextResponse.json({ success: true, count: data.length, data }, { status: 200 });
  } catch (err) {
    return apiError(request, err);
  }
}
