import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { supabaseAdminEngine } from '@/lib/supabase-server';
import { apiError } from '@/lib/api-response';
import { ownedPlanInvoice, planBalanceOf } from '@/lib/building-plan';
import { currentCredentials, createCharge } from '@/lib/payments/uddoktapay';
import { resolveAppBaseUrl, resolveApiBaseUrl } from '@/lib/public-url';

// =====================================================================================
// 👑 SUPER ADMIN — GENERATE AN ONLINE PAY LINK FOR A BUILDING PLAN INVOICE
// POST -> create an UddoktaPay charge for the invoice's outstanding balance and store the
//         checkout URL in the invoice's existing `payment_url` column.
//
// Admin-only via the /api/super-admin/* gate in middleware.ts.
//
// The building admin is NOT given a self-serve button: a building contract is a negotiated
// arrangement, and the super admin decides when it is ready to be paid. That column has existed
// since ADD_BUILDING_PLANS.sql for exactly this — it was previously a link pasted in by hand.
//
// The link is a plain URL, so it can be emailed, WhatsApp'd or read out. Nothing about it is
// secret: it can only ever pay THIS invoice, and paying it is the outcome we want. Anyone who
// pays someone else's building invoice has made a donation, not an attack.
//
// When it is paid, lib/payments/uddoktapay-fulfil.ts inserts the building_plan_payments row and
// runs the same recalc -> activate ladder the manual "record a payment" route uses. Regenerating
// the link makes a NEW invoice at the gateway; both remain payable, and the unique index on
// gateway_invoice_id means each can be credited at most once.
// =====================================================================================

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; invoiceId: string }> },
) {
  try {
    const { id: buildingId, invoiceId } = await params; // params is a Promise in Next 16

    const invoice: any = await ownedPlanInvoice(invoiceId, buildingId);
    if (!invoice) {
      return NextResponse.json({ success: false, error: 'Invoice not found.' }, { status: 404 });
    }
    if (invoice.status === 'void') {
      return NextResponse.json(
        { success: false, error: 'This invoice is void. Raise a new one before asking for money against it.' },
        { status: 409 },
      );
    }

    const balance = planBalanceOf(invoice);
    if (balance <= 0) {
      return NextResponse.json(
        { success: false, error: 'This invoice is already settled — there is nothing to pay.' },
        { status: 409 },
      );
    }

    const credentials = await currentCredentials();
    if (!credentials) {
      return NextResponse.json(
        { success: false, error: 'Add a working UddoktaPay API key for the selected mode before generating a pay link.' },
        { status: 400 },
      );
    }

    // The billing contact on the invoice, snapshotted at issue time so it survives the building
    // being renamed or deleted (ADD_DELETION_AUDIT.sql).
    let adminEmail = invoice.admin_email || '';
    if (!adminEmail && invoice.admin_id) {
      try {
        const { data: authRes } = await supabaseAdminEngine.auth.admin.getUserById(invoice.admin_id);
        adminEmail = authRes?.user?.email || '';
      } catch { /* non-fatal */ }
    }

    const appBase = resolveAppBaseUrl(request);
    const apiBase = resolveApiBaseUrl(request);

    const charge = await createCharge(
      {
        fullName: invoice.building_name || 'Building administrator',
        email: adminEmail || 'no-reply@bari360.space',
        amount: balance,
        metadata: {
          kind: 'building_invoice',
          invoice_id: String(invoice.id),
          building_id: String(buildingId),
        },
        redirectUrl: `${appBase}/payment/return`,
        cancelUrl: `${appBase}/payment/cancelled`,
        webhookUrl: `${apiBase}/api/payments/uddoktapay/webhook`,
      },
      credentials,
    );

    const { data: updated, error } = await supabaseAdminEngine
      .from('building_plan_invoices')
      .update({ payment_url: charge.payment_url, updated_at: new Date().toISOString() })
      .eq('id', invoice.id)
      .select('*')
      .single();
    if (error) throw error;

    return NextResponse.json(
      { success: true, data: { paymentUrl: charge.payment_url, amount: balance, invoice: updated } },
      { status: 200 },
    );
  } catch (err) {
    return apiError(request, err);
  }
}
