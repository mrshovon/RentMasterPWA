import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { supabaseAdminEngine } from '@/lib/supabase-server';
import { apiError } from '@/lib/api-response';
import { MISSING_SCHEMA_CODES } from '@/lib/account-purge';

// =====================================================================================
// 👑 SUPER ADMIN — DELETED BUILDINGS (AUDIT)
// GET -> the plan invoices and payments of buildings that no longer exist, grouped by the
//        building they belonged to.
//
// WHY THIS ROUTE EXISTS. ADD_DELETION_AUDIT.sql drops the buildings foreign key so that what we
// billed a building and what they paid us survives the building's deletion. That preserved the
// data and made it INVISIBLE: every other building screen reads by joining to `buildings`, and
// there is no row left to join to. This is the one screen that reads the other way round.
//
// No auth code here on purpose: middleware.ts gates every /api/super-admin/* path on
// user_metadata.role === 'admin' and returns 403 before a handler ever runs.
//
// The orphan test is done in memory against the full building id list rather than with a NOT IN
// filter, because PostgREST has no anti-join and the alternative is a URL carrying every building
// id we have. Both lists are small — one row per building, one per invoice ever raised.
// =====================================================================================

interface ArchivedBuilding {
  buildingId: string;
  /** The name snapshotted onto the invoice when it was raised. Null on invoices raised before
   *  ADD_DELETION_AUDIT.sql added the column — the id is then the only identifier there is. */
  buildingName: string | null;
  adminId: string | null;
  adminEmail: string | null;
  invoices: any[];
  payments: any[];
  totals: { billed: number; received: number; due: number };
}

export async function GET(request: NextRequest) {
  try {
    const { data: invoices, error } = await supabaseAdminEngine
      .from('building_plan_invoices')
      .select('*')
      .order('created_at', { ascending: false });

    // Before ADD_BUILDING_PLANS.sql there is no table at all, which is "nothing archived", not a
    // failure — the same posture every other building read takes.
    if (error) {
      if (MISSING_SCHEMA_CODES.includes(error.code || '')) {
        return NextResponse.json({ success: true, count: 0, data: [] }, { status: 200 });
      }
      throw error;
    }

    const rows = invoices || [];
    if (!rows.length) {
      return NextResponse.json({ success: true, count: 0, data: [] }, { status: 200 });
    }

    const { data: live, error: liveErr } = await supabaseAdminEngine.from('buildings').select('id');
    if (liveErr) throw liveErr;
    const liveIds = new Set((live || []).map((b: { id: string }) => String(b.id)));

    const orphans = rows.filter((i: any) => !liveIds.has(String(i.building_id)));
    if (!orphans.length) {
      return NextResponse.json({ success: true, count: 0, data: [] }, { status: 200 });
    }

    // Payments hang off the invoice, which is what survived — so they are still reachable, and a
    // building's payment history is one `in` rather than a query per invoice.
    const invoiceIds = orphans.map((i: any) => String(i.id));
    const { data: payments } = await supabaseAdminEngine
      .from('building_plan_payments')
      .select('*')
      .in('invoice_id', invoiceIds)
      .order('paid_on', { ascending: false });

    const grouped: Record<string, ArchivedBuilding> = {};
    for (const inv of orphans) {
      const key = String(inv.building_id);
      grouped[key] ||= {
        buildingId: key,
        buildingName: inv.building_name || null,
        adminId: inv.admin_id ? String(inv.admin_id) : null,
        adminEmail: inv.admin_email || null,
        invoices: [],
        payments: [],
        totals: { billed: 0, received: 0, due: 0 },
      };
      const group = grouped[key];
      // Older invoices carry no snapshot; a newer one in the same building may. Take the first
      // non-null rather than the newest row's value, so one un-snapshotted invoice cannot leave
      // the whole group nameless.
      group.buildingName ||= inv.building_name || null;
      group.adminEmail ||= inv.admin_email || null;
      group.invoices.push(inv);
      group.totals.billed += Number(inv.total_payable || 0);
      group.totals.received += Number(inv.amount_paid || 0);
    }

    for (const p of payments || []) {
      const inv = orphans.find((i: any) => String(i.id) === String(p.invoice_id));
      if (inv) grouped[String(inv.building_id)]?.payments.push(p);
    }

    const data = Object.values(grouped)
      .map((g) => ({ ...g, totals: { ...g.totals, due: Math.max(0, g.totals.billed - g.totals.received) } }))
      .sort((a, b) => String(b.invoices[0]?.created_at || '').localeCompare(String(a.invoices[0]?.created_at || '')));

    return NextResponse.json({ success: true, count: data.length, data }, { status: 200 });
  } catch (err) {
    return apiError(request, err);
  }
}
