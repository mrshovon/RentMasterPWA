import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { supabaseAdminEngine } from '@/lib/supabase-server';
import { apiError } from '@/lib/api-response';
import { requireBuildingAdmin, ownerInBuilding } from '@/lib/building';

// =====================================================================================
// 🏢 BUILDING ADMIN — PRINTABLE REPORTS (data only)
//
// GET ?kind=income_expense&from=YYYY-MM-DD&to=YYYY-MM-DD
//     -> the building's income and expenses for a period, grouped by category.
//
// GET ?kind=owner_statement&ownerId=…[&from&to]
//     -> one flat owner's service-charge account: every invoice, what was received against it,
//        and what is still owed.
//
// This returns JSON, not HTML. The document itself is built in the browser by
// lib/building-print.ts, for the same reason receipts are: the printable string has to render
// identically in the preview iframe and the print window, and it has to respect the reader's
// language, which lives on the client.
//
// Amounts are read from account_transactions (the real ledger) and building_service_invoices.
// Nothing here reads building_amenities / building_income_sources — those are definitions and
// would double-count if they were treated as money. See ADD_BUILDING_EXTRAS.sql.
// =====================================================================================

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** A sane default window: the calendar month we are in. */
function defaultRange(): { from: string; to: string } {
  const now = new Date();
  const first = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const last = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0));
  return { from: first.toISOString().slice(0, 10), to: last.toISOString().slice(0, 10) };
}

export async function GET(request: NextRequest) {
  try {
    const gate = await requireBuildingAdmin(request);
    if (!gate.ok) return NextResponse.json(gate.body, { status: gate.status });

    const params = request.nextUrl.searchParams;
    const kind = params.get('kind') || 'income_expense';

    const fallback = defaultRange();
    const from = DATE_RE.test(params.get('from') || '') ? params.get('from')! : fallback.from;
    const to = DATE_RE.test(params.get('to') || '') ? params.get('to')! : fallback.to;
    if (from > to) {
      return NextResponse.json(
        { success: false, error: 'The start date is after the end date.' },
        { status: 400 }
      );
    }

    const building = {
      id: gate.building!.id,
      name: gate.building!.name,
      address: gate.building!.address,
      city: gate.building!.city,
      letterheadUrl: gate.building!.letterhead_url,
      signatoryName: gate.building!.signatory_name,
      signatoryTitle: gate.building!.signatory_title,
    };

    // ---- Income / expense statement -------------------------------------------------------
    if (kind === 'income_expense') {
      const { data: txns, error } = await supabaseAdminEngine
        .from('account_transactions')
        .select('direction, amount, category, txn_date')
        .eq('owner_id', gate.uid!)
        .gte('txn_date', from)
        .lte('txn_date', to)
        .order('txn_date', { ascending: true });
      if (error) throw error;

      // Grouped in JS rather than with a database aggregate: PostgREST cannot GROUP BY without a
      // view or an RPC, and a building's transaction count over a period is small enough that
      // the round trip costs more than the loop.
      const bucket = (rows: any[], direction: string) => {
        const byCategory: Record<string, number> = {};
        let total = 0;
        rows
          .filter((r) => r.direction === direction)
          .forEach((r) => {
            const key = String(r.category || 'Uncategorised');
            const amount = Number(r.amount || 0);
            byCategory[key] = (byCategory[key] || 0) + amount;
            total += amount;
          });
        return {
          total,
          lines: Object.entries(byCategory)
            .map(([category, amount]) => ({ category, amount }))
            .sort((a, b) => b.amount - a.amount),
        };
      };

      const rows = txns || [];
      const income = bucket(rows, 'income');
      const expense = bucket(rows, 'expense');

      return NextResponse.json(
        {
          success: true,
          kind,
          building,
          period: { from, to },
          income,
          expense,
          net: income.total - expense.total,
          entryCount: rows.length,
        },
        { status: 200 }
      );
    }

    // ---- One owner's service-charge statement ---------------------------------------------
    if (kind === 'owner_statement') {
      const ownerId = String(params.get('ownerId') || '').trim();
      if (!ownerId) {
        return NextResponse.json({ success: false, error: 'An owner is required.' }, { status: 400 });
      }
      if (!(await ownerInBuilding(gate.building!.id, ownerId))) {
        return NextResponse.json(
          { success: false, error: 'That owner is not in your building.' },
          { status: 404 }
        );
      }

      const { data: roster } = await supabaseAdminEngine
        .from('building_owners')
        .select('unit_label, default_service_charge, joined_at')
        .eq('building_id', gate.building!.id)
        .eq('owner_id', ownerId)
        .maybeSingle();

      let ownerName: string | null = null;
      let ownerEmail: string | null = null;
      try {
        const { data: authRes } = await supabaseAdminEngine.auth.admin.getUserById(ownerId);
        ownerName = ((authRes?.user?.user_metadata as any) || {}).name || null;
        ownerEmail = authRes?.user?.email || null;
      } catch {
        /* the statement still prints without a name; the unit label identifies them */
      }

      // The whole account by default. A date filter here would silently drop the opening
      // balance, which is exactly the number a statement exists to explain.
      const { data: invoices, error } = await supabaseAdminEngine
        .from('building_service_invoices')
        .select('*')
        .eq('owner_id', ownerId)
        .eq('building_id', gate.building!.id)
        .order('billing_month', { ascending: true });
      if (error) throw error;

      const ids = (invoices || []).map((i: any) => String(i.id));
      let byInvoice: Record<string, any[]> = {};
      if (ids.length) {
        const { data: payments } = await supabaseAdminEngine
          .from('building_service_payments')
          .select('*')
          .in('invoice_id', ids)
          .order('paid_on', { ascending: true });
        byInvoice = (payments || []).reduce((acc: Record<string, any[]>, p: any) => {
          (acc[String(p.invoice_id)] ||= []).push(p);
          return acc;
        }, {});
      }

      const rows = (invoices || []).map((i: any) => ({
        ...i,
        payments: byInvoice[String(i.id)] || [],
      }));

      const billed = rows.reduce((s, i) => s + Number(i.total_payable || 0), 0);
      const received = rows.reduce((s, i) => s + Number(i.amount_paid || 0), 0);

      return NextResponse.json(
        {
          success: true,
          kind,
          building,
          owner: {
            id: ownerId,
            name: ownerName,
            email: ownerEmail,
            unitLabel: roster?.unit_label || null,
            defaultServiceCharge: Number(roster?.default_service_charge || 0),
            joinedAt: roster?.joined_at || null,
          },
          invoices: rows,
          totals: { billed, received, due: Math.max(0, billed - received) },
        },
        { status: 200 }
      );
    }

    return NextResponse.json({ success: false, error: 'Unknown report.' }, { status: 400 });
  } catch (err) {
    return apiError(request, err);
  }
}
