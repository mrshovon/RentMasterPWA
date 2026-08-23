import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { supabaseAdminEngine } from '@/lib/supabase-server';
import { assertOwnerCanWrite } from '@/lib/subscription';
import { apiError } from '@/lib/api-response';
import { requireBuildingAdmin } from '@/lib/building';
import {
  INVOICE_SELECT,
  ownedBuildingInvoice,
  invoiceAmountsFrom,
  recalcBuildingInvoice,
  SETTLED_BUILDING_INVOICE_ERROR,
} from '@/lib/building-billing';

// =====================================================================================
// 🏢 BUILDING ADMIN — ONE SERVICE CHARGE INVOICE
// GET    -> the invoice plus its payments.
// PATCH  -> correct the charge lines / note. Refused once the invoice is settled.
// DELETE -> remove it. Refused once ANY money has been recorded against it, because the
//           payments carry booked income in account_transactions and a cascade delete would
//           orphan it silently.
// =====================================================================================

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;

    const gate = await requireBuildingAdmin(request);
    if (!gate.ok) return NextResponse.json(gate.body, { status: gate.status });

    const invoice = await ownedBuildingInvoice(id, gate.building!.id);
    if (!invoice) {
      return NextResponse.json({ success: false, error: 'Invoice not found.' }, { status: 404 });
    }

    const { data: payments, error } = await supabaseAdminEngine
      .from('building_service_payments')
      .select('*')
      .eq('invoice_id', id)
      .order('paid_on', { ascending: true });
    if (error) throw error;

    return NextResponse.json(
      { success: true, data: { ...invoice, payments: payments || [] } },
      { status: 200 }
    );
  } catch (err) {
    return apiError(request, err);
  }
}

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;

    const gate = await requireBuildingAdmin(request);
    if (!gate.ok) return NextResponse.json(gate.body, { status: gate.status });

    const guard = await assertOwnerCanWrite(request.headers.get('x-rentmaster-role'), gate.uid!);
    if (!guard.ok) return NextResponse.json(guard.body, { status: guard.status });

    const invoice = await ownedBuildingInvoice(id, gate.building!.id);
    if (!invoice) {
      return NextResponse.json({ success: false, error: 'Invoice not found.' }, { status: 404 });
    }
    if (invoice.payment_status === 'paid') {
      return NextResponse.json(
        { success: false, error: SETTLED_BUILDING_INVOICE_ERROR, code: 'SETTLED_INVOICE' },
        { status: 409 }
      );
    }

    const body = await request.json();
    const update: Record<string, unknown> = { updated_at: new Date().toISOString() };

    // Only recompute the money when the request actually names a charge line, so a note-only
    // edit cannot quietly rewrite the total from defaults.
    const touchesAmounts =
      body.serviceCharge !== undefined || body.extraCharge !== undefined ||
      body.discount !== undefined || body.extraChargeRemarks !== undefined;
    if (touchesAmounts) {
      Object.assign(
        update,
        invoiceAmountsFrom(
          {
            serviceCharge: body.serviceCharge ?? invoice.service_charge,
            extraCharge: body.extraCharge ?? invoice.extra_charge,
            discount: body.discount ?? invoice.discount,
            extraChargeRemarks: body.extraChargeRemarks ?? invoice.extra_charge_remarks,
          },
          Number(invoice.service_charge || 0)
        )
      );
    }
    if (body.note !== undefined) {
      update.note = body.note ? String(body.note).trim().slice(0, 1000) : null;
    }

    const { error } = await supabaseAdminEngine
      .from('building_service_invoices')
      .update(update)
      .eq('id', id)
      .eq('building_id', gate.building!.id);
    if (error) throw error;

    // Changing the total can move the status — a partial invoice whose charge is corrected
    // downward may now be fully covered. The recalc is the only thing allowed to decide that.
    const refreshed = touchesAmounts
      ? await recalcBuildingInvoice(id)
      : await ownedBuildingInvoice(id, gate.building!.id);

    return NextResponse.json({ success: true, data: refreshed }, { status: 200 });
  } catch (err) {
    return apiError(request, err);
  }
}

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;

    const gate = await requireBuildingAdmin(request);
    if (!gate.ok) return NextResponse.json(gate.body, { status: gate.status });

    const guard = await assertOwnerCanWrite(request.headers.get('x-rentmaster-role'), gate.uid!);
    if (!guard.ok) return NextResponse.json(guard.body, { status: guard.status });

    const invoice = await ownedBuildingInvoice(id, gate.building!.id);
    if (!invoice) {
      return NextResponse.json({ success: false, error: 'Invoice not found.' }, { status: 404 });
    }

    // Checked against the payments table, not the derived amount_paid column: the derived value
    // is what we are protecting, so it must not also be the thing that decides it is safe to go.
    const { count } = await supabaseAdminEngine
      .from('building_service_payments')
      .select('id', { count: 'exact', head: true })
      .eq('invoice_id', id);
    if ((count || 0) > 0) {
      return NextResponse.json(
        {
          success: false,
          error: 'Money has been recorded against this invoice. Delete the payments first, so the income entries they created are reversed too.',
          code: 'INVOICE_HAS_PAYMENTS',
        },
        { status: 409 }
      );
    }

    const { error } = await supabaseAdminEngine
      .from('building_service_invoices')
      .delete()
      .eq('id', id)
      .eq('building_id', gate.building!.id);
    if (error) throw error;

    return NextResponse.json({ success: true }, { status: 200 });
  } catch (err) {
    return apiError(request, err);
  }
}
