import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import crypto from 'crypto';
import { supabaseAdminEngine } from '@/lib/supabase-server';
import { apiError } from '@/lib/api-response';
import { notifyOwner } from '@/lib/notify';
import { itemsFrom, planForBuilding, addMonths, today } from '@/lib/building-plan';
import { missingColumnFrom } from '@/lib/plan-addons';

// =====================================================================================
// 👑 SUPER ADMIN — RAISE A PLAN INVOICE FOR A BUILDING
// POST -> compose the quote: line items, discount, terms, payment link, due date.
//
// The line items ARE the pricing model. Year 1 is a plan line on its own; year 2 is the same
// plan line plus "Maintenance & support" plus whatever extra modules the building has taken.
// That is why this feature adds no subscription_tiers row: raising a price is composing a
// different invoice, not minting a new plan that then clutters the Plans menu forever.
//
// `copyFrom` seeds the lines from a previous invoice, because a renewal is almost always last
// year's bill plus one line — retyping it is how a figure quietly changes by a digit.
// =====================================================================================

const INVOICE_KINDS = ['initial', 'renewal'] as const;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id: buildingId } = await params;
    const body = await request.json();

    const { data: building } = await supabaseAdminEngine
      .from('buildings')
      .select('id, admin_id, name')
      .eq('id', buildingId)
      .maybeSingle();
    if (!building) {
      return NextResponse.json({ success: false, error: 'Building not found.' }, { status: 404 });
    }

    const subscription = await planForBuilding(buildingId);

    // Seed from a previous invoice when asked, otherwise take what was submitted.
    let items = itemsFrom(body.items);
    if (!items.length && body.copyFrom) {
      const { data: prior } = await supabaseAdminEngine
        .from('building_plan_invoice_items')
        .select('label, amount, sort_order')
        .eq('invoice_id', String(body.copyFrom))
        .order('sort_order', { ascending: true });
      items = (prior || []).map((p: any, i: number) => ({
        label: String(p.label),
        amount: Number(p.amount || 0),
        sort_order: i,
      }));
    }
    if (!items.length) {
      return NextResponse.json(
        { success: false, error: 'Add at least one line to the invoice.' },
        { status: 400 }
      );
    }

    const kind = (INVOICE_KINDS as readonly string[]).includes(body.kind) ? String(body.kind) : 'renewal';
    const termMonths = Math.max(1, Math.round(Number(body.termMonths) || subscription?.term_months || 12));

    const subtotal = items.reduce((sum, i) => sum + i.amount, 0);
    const discountRaw = Number(body.discount);
    const discount = Number.isFinite(discountRaw) && discountRaw > 0 ? discountRaw : 0;
    // Computed here, never taken from the client, and clamped at zero — a discount larger than
    // the subtotal is a data-entry slip, and a negative payable makes the status ladder nonsense.
    const totalPayable = Math.max(0, subtotal - discount);

    // What the bill covers. A renewal continues from the current expiry; an initial invoice has
    // no period yet, because the term starts the day it is PAID.
    let periodStart: string | null = null;
    if (DATE_RE.test(String(body.periodStart || '').slice(0, 10))) {
      periodStart = String(body.periodStart).slice(0, 10);
    } else if (kind === 'renewal' && subscription?.expiry_date) {
      const end = String(subscription.expiry_date).slice(0, 10);
      periodStart = end > today() ? end : today();
    }
    const periodEnd = periodStart ? addMonths(periodStart, termMonths) : null;

    const dueOn = DATE_RE.test(String(body.dueOn || '').slice(0, 10)) ? String(body.dueOn).slice(0, 10) : null;
    const paymentUrl = String(body.paymentUrl ?? '').trim().slice(0, 1000) || null;
    // Only ever handed to the building as a link to follow; anything but http(s) is either a
    // mistake or a javascript: URL rendered into their dashboard.
    if (paymentUrl && !/^https?:\/\//i.test(paymentUrl)) {
      return NextResponse.json(
        { success: false, error: 'The payment link must start with http:// or https://.' },
        { status: 400 }
      );
    }

    // Draft by default: a quote is composed over a few minutes and must not appear half-written
    // on the building's dashboard. `send: true` publishes it in one step for the common case.
    const send = body.send !== false;
    const invoiceId = crypto.randomUUID();

    // Identity snapshot. This invoice now OUTLIVES its building — ADD_DELETION_AUDIT.sql drops
    // the cascade so a deleted building's payment record survives for audit — and once the
    // buildings row is gone there is nothing left to join to for a name. Same reasoning as
    // payment_submissions.owner_email. Best-effort on the email: a missing one is a blank column,
    // never a failed invoice.
    let adminEmail: string | null = null;
    try {
      const { data: adminUser } = await supabaseAdminEngine.auth.admin.getUserById(building.admin_id);
      adminEmail = adminUser?.user?.email || null;
    } catch {
      /* non-fatal — building_name alone still identifies the counterparty */
    }

    const row: Record<string, unknown> = {
        id: invoiceId,
        building_id: buildingId,
        building_name: building.name,
        admin_email: adminEmail,
        admin_id: building.admin_id,
        kind,
        term_months: termMonths,
        period_start: periodStart,
        period_end: periodEnd,
        subtotal,
        discount,
        total_payable: totalPayable,
        terms: String(body.terms ?? '').trim().slice(0, 5000) || null,
        payment_url: paymentUrl,
        status: send ? 'sent' : 'draft',
        issued_at: send ? new Date().toISOString() : null,
        due_on: dueOn,
        note: String(body.note ?? '').trim().slice(0, 2000) || null,
    };

    let { data: invoice, error } = await supabaseAdminEngine
      .from('building_plan_invoices')
      .insert([row])
      .select('*')
      .single();

    // Pre-migration grace, same shape as /api/super-admin/tiers: retry without the snapshot
    // columns when ADD_DELETION_AUDIT.sql has not been run yet, so raising an invoice never
    // depends on a migration — and say loudly what needs running, because until it does the
    // cascade this snapshot exists for is still live.
    if (['PGRST204', '42703'].includes(error?.code || '')) {
      const missing = missingColumnFrom(error?.message, row);
      if (missing.length) {
        console.error(`[building-plan-invoice] building_plan_invoices is missing ${missing.join(', ')} — run ADD_DELETION_AUDIT.sql. Raising the invoice without ${missing.length === 1 ? 'it' : 'them'}.`);
        const retry = { ...row };
        for (const col of missing) delete retry[col];
        ({ data: invoice, error } = await supabaseAdminEngine
          .from('building_plan_invoices')
          .insert([retry])
          .select('*')
          .single());
      }
    }

    if (error) throw error;

    const { error: itemErr } = await supabaseAdminEngine
      .from('building_plan_invoice_items')
      .insert(items.map((i) => ({ id: crypto.randomUUID(), invoice_id: invoiceId, ...i })));
    if (itemErr) {
      // An invoice with no lines is worse than no invoice: the total would stand with nothing
      // explaining it. Roll the header back rather than leaving that on someone's dashboard.
      await supabaseAdminEngine.from('building_plan_invoices').delete().eq('id', invoiceId);
      throw itemErr;
    }

    // Tie the quote back to the request that asked for it, and mark that request quoted.
    if (body.requestId) {
      await supabaseAdminEngine
        .from('building_plan_requests')
        .update({ invoice_id: invoiceId, status: 'quoted', updated_at: new Date().toISOString() })
        .eq('id', String(body.requestId))
        .eq('building_id', buildingId);
    }

    if (send) {
      // notifyOwner writes an in-app notice AND fires the push, both non-fatal. Push copy is
      // English-only by design (lib/notify.ts) — the service worker has no translation context.
      void notifyOwner({
        userId: building.admin_id,
        title: 'Your plan invoice is ready',
        body: `৳${totalPayable} for ${termMonths} months. Open your Plan tab to see the details.`,
        url: '/building#plan',
        tag: `building-invoice-${invoiceId}`,
      });
    }

    return NextResponse.json({ success: true, data: { ...invoice, items } }, { status: 201 });
  } catch (err) {
    return apiError(request, err);
  }
}
