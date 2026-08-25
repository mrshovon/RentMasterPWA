import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import crypto from 'crypto';
import { supabaseAdminEngine } from '@/lib/supabase-server';
import { apiError } from '@/lib/api-response';
import { notifyOwner } from '@/lib/notify';
import {
  itemsFrom,
  ownedPlanInvoice,
  planBalanceOf,
  SETTLED_PLAN_INVOICE_ERROR,
} from '@/lib/building-plan';

// =====================================================================================
// 👑 SUPER ADMIN — EDIT / SEND / VOID ONE PLAN INVOICE
// PATCH  -> revise the lines, terms, link or dates; publish a draft; void it.
// DELETE -> remove a draft that was never sent.
//
// A SETTLED invoice is frozen. Once the money is confirmed the figures may not move, for the
// same reason building_service_invoices freezes: the recalc would walk the status backwards and
// the receipt the building already holds would stop matching what we hold. Void-and-reissue is
// the honest correction, so that is the only route left open.
// =====================================================================================

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; invoiceId: string }> }
) {
  try {
    const { id: buildingId, invoiceId } = await params;
    const body = await request.json();

    const invoice: any = await ownedPlanInvoice(invoiceId, buildingId);
    if (!invoice) {
      return NextResponse.json({ success: false, error: 'Invoice not found.' }, { status: 404 });
    }

    // Voiding is always allowed — it is how a settled invoice gets corrected.
    if (body.action === 'void') {
      const { data, error } = await supabaseAdminEngine
        .from('building_plan_invoices')
        .update({ status: 'void', updated_at: new Date().toISOString() })
        .eq('id', invoiceId)
        .select('*')
        .single();
      if (error) throw error;
      return NextResponse.json({ success: true, data }, { status: 200 });
    }

    if (invoice.payment_status === 'paid' || invoice.status === 'settled') {
      return NextResponse.json({ success: false, error: SETTLED_PLAN_INVOICE_ERROR }, { status: 409 });
    }

    const patch: Record<string, any> = {};

    // Lines are replaced wholesale rather than diffed: the client edits a list, and a partial
    // update would leave a removed line behind whenever a request failed halfway.
    const items = body.items === undefined ? null : itemsFrom(body.items);
    if (items) {
      if (!items.length) {
        return NextResponse.json(
          { success: false, error: 'An invoice needs at least one line.' },
          { status: 400 }
        );
      }
      const subtotal = items.reduce((sum, i) => sum + i.amount, 0);
      const discountRaw = Number(body.discount ?? invoice.discount);
      const discount = Number.isFinite(discountRaw) && discountRaw > 0 ? discountRaw : 0;
      patch.subtotal = subtotal;
      patch.discount = discount;
      patch.total_payable = Math.max(0, subtotal - discount);
    } else if (body.discount !== undefined) {
      const discountRaw = Number(body.discount);
      const discount = Number.isFinite(discountRaw) && discountRaw > 0 ? discountRaw : 0;
      patch.discount = discount;
      patch.total_payable = Math.max(0, Number(invoice.subtotal || 0) - discount);
    }

    if (body.terms !== undefined) patch.terms = String(body.terms ?? '').trim().slice(0, 5000) || null;
    if (body.note !== undefined) patch.note = String(body.note ?? '').trim().slice(0, 2000) || null;

    if (body.paymentUrl !== undefined) {
      const url = String(body.paymentUrl ?? '').trim().slice(0, 1000) || null;
      if (url && !/^https?:\/\//i.test(url)) {
        return NextResponse.json(
          { success: false, error: 'The payment link must start with http:// or https://.' },
          { status: 400 }
        );
      }
      patch.payment_url = url;
    }

    if (body.dueOn !== undefined) {
      const s = String(body.dueOn || '').slice(0, 10);
      patch.due_on = DATE_RE.test(s) ? s : null;
    }
    if (body.termMonths !== undefined) {
      const n = Math.round(Number(body.termMonths));
      if (Number.isFinite(n) && n > 0 && n <= 120) patch.term_months = n;
    }

    // Publishing a draft. Only a draft can be sent — re-sending a live invoice would restamp its
    // issue date and reset the due-date arithmetic the building has already been told about.
    const publishing = body.action === 'send' && invoice.status === 'draft';
    if (publishing) {
      patch.status = 'sent';
      patch.issued_at = new Date().toISOString();
    }

    if (!Object.keys(patch).length) {
      return NextResponse.json({ success: false, error: 'Nothing to update.' }, { status: 400 });
    }
    patch.updated_at = new Date().toISOString();

    const { data: updated, error } = await supabaseAdminEngine
      .from('building_plan_invoices')
      .update(patch)
      .eq('id', invoiceId)
      .select('*')
      .single();
    if (error) throw error;

    if (items) {
      await supabaseAdminEngine.from('building_plan_invoice_items').delete().eq('invoice_id', invoiceId);
      const { error: itemErr } = await supabaseAdminEngine
        .from('building_plan_invoice_items')
        .insert(items.map((i) => ({ id: crypto.randomUUID(), invoice_id: invoiceId, ...i })));
      if (itemErr) throw itemErr;
    }

    if (publishing) {
      void notifyOwner({
        userId: invoice.admin_id,
        title: 'Your plan invoice is ready',
        body: `৳${updated.total_payable} for ${updated.term_months} months. Open your Plan tab to see the details.`,
        url: '/building#plan',
        tag: `building-invoice-${invoiceId}`,
      });
    }

    return NextResponse.json(
      { success: true, data: { ...updated, balance: planBalanceOf(updated) } },
      { status: 200 }
    );
  } catch (err) {
    return apiError(request, err);
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; invoiceId: string }> }
) {
  try {
    const { id: buildingId, invoiceId } = await params;

    const invoice: any = await ownedPlanInvoice(invoiceId, buildingId);
    if (!invoice) {
      return NextResponse.json({ success: false, error: 'Invoice not found.' }, { status: 404 });
    }
    // Anything the building has seen, or that money has touched, is voided rather than erased —
    // a deleted invoice takes its payment history down with it via the FK cascade.
    if (invoice.status !== 'draft') {
      return NextResponse.json(
        { success: false, error: 'Only a draft can be deleted. Void this invoice instead.' },
        { status: 409 }
      );
    }

    const { error } = await supabaseAdminEngine.from('building_plan_invoices').delete().eq('id', invoiceId);
    if (error) throw error;

    return NextResponse.json({ success: true }, { status: 200 });
  } catch (err) {
    return apiError(request, err);
  }
}
