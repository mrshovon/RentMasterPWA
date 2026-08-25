import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import crypto from 'crypto';
import { supabaseAdminEngine } from '@/lib/supabase-server';
import { apiError } from '@/lib/api-response';
import { notifyOwner } from '@/lib/notify';
import {
  ownedPlanInvoice,
  recalcPlanInvoice,
  activateBuildingTerm,
  planBalanceOf,
  today,
} from '@/lib/building-plan';

// =====================================================================================
// 👑 SUPER ADMIN — WORK A BUILDING REQUEST
// PATCH -> move a renewal request or a payment claim along, and leave a note the building reads.
//
// `action: 'accept'` on a PAYMENT CLAIM is the one that does real work: it turns the claim into a
// building_plan_payments row against an invoice, runs the same recalc/activate ladder the manual
// entry route does, and closes the request. Until an admin does that, a claim is only a claim —
// which is the whole reason it is not a payment row to begin with.
//
// Lives at /api/super-admin/building-requests/ rather than under .../buildings/[id]/requests/
// because the console works this queue request-first, without a building in hand. Routing it
// under the building id would mean the badge could not link to a single item.
// =====================================================================================

const VALID_STATUS = ['new', 'in_progress', 'quoted', 'closed', 'rejected'];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ requestId: string }> }
) {
  try {
    const { requestId } = await params;
    const body = await request.json();

    const { data: existing } = await supabaseAdminEngine
      .from('building_plan_requests')
      .select('*')
      .eq('id', requestId)
      .maybeSingle();
    if (!existing) {
      return NextResponse.json({ success: false, error: 'Request not found.' }, { status: 404 });
    }

    const adminNotes =
      body.adminNotes === undefined ? undefined : String(body.adminNotes ?? '').trim().slice(0, 2000) || null;

    // ---- Accepting a payment claim.
    if (body.action === 'accept') {
      if (existing.kind !== 'payment_claim') {
        return NextResponse.json(
          { success: false, error: 'Only a payment claim can be accepted. Raise an invoice for a renewal request.' },
          { status: 400 }
        );
      }
      if (existing.status === 'closed') {
        // The double-click guard. Without it, accepting twice mints a second payment and can
        // push a term forward a second year on one transfer.
        return NextResponse.json(
          { success: false, error: 'This claim has already been accepted.' },
          { status: 409 }
        );
      }

      const invoiceId = String(body.invoiceId || existing.invoice_id || '');
      if (!invoiceId) {
        return NextResponse.json(
          { success: false, error: 'Choose which invoice this payment settles.' },
          { status: 400 }
        );
      }
      const invoice: any = await ownedPlanInvoice(invoiceId, existing.building_id);
      if (!invoice) {
        return NextResponse.json({ success: false, error: 'Invoice not found for this building.' }, { status: 404 });
      }
      if (invoice.status === 'void') {
        return NextResponse.json(
          { success: false, error: 'That invoice is void. Raise a new one before accepting money against it.' },
          { status: 409 }
        );
      }

      // The admin confirms the figure — the building's claimed amount is a starting point, not
      // an instruction. What we actually received is what gets recorded.
      const amountRaw = body.amount === undefined ? existing.claim_amount : body.amount;
      const amount = Number(amountRaw);
      if (!Number.isFinite(amount) || amount <= 0) {
        return NextResponse.json({ success: false, error: 'Enter the amount actually received.' }, { status: 400 });
      }
      const paidOn = DATE_RE.test(String(body.paidOn || '').slice(0, 10))
        ? String(body.paidOn).slice(0, 10)
        : today();

      const { error: payErr } = await supabaseAdminEngine
        .from('building_plan_payments')
        .insert([{
          id: crypto.randomUUID(),
          invoice_id: invoiceId,
          building_id: existing.building_id,
          admin_id: existing.admin_id,
          amount,
          paid_on: paidOn,
          method: existing.claim_method || 'bank',
          reference: existing.claim_reference || null,
          // Null on purpose: this money came from a claim we confirmed, not one we collected.
          recorded_by: null,
          note: `Confirmed from the building's payment claim #${existing.request_no}.`,
        }]);
      if (payErr) throw payErr;

      const updatedInvoice: any = await recalcPlanInvoice(invoiceId);

      let subscription: any = null;
      if (updatedInvoice?.payment_status === 'paid') {
        subscription = await activateBuildingTerm(existing.building_id, {
          months: Number(updatedInvoice.term_months || 12),
          startOn: DATE_RE.test(String(invoice.period_start || '').slice(0, 10))
            ? String(invoice.period_start).slice(0, 10)
            : null,
        });
      }

      const { data: closed, error: closeErr } = await supabaseAdminEngine
        .from('building_plan_requests')
        .update({
          status: 'closed',
          invoice_id: invoiceId,
          admin_notes: adminNotes ?? existing.admin_notes,
          reviewed_by: request.headers.get('x-rentmaster-uid'),
          reviewed_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq('id', requestId)
        .select('*')
        .single();
      if (closeErr) throw closeErr;

      void notifyOwner({
        userId: existing.admin_id,
        title: updatedInvoice?.payment_status === 'paid' ? 'Payment confirmed — plan renewed' : 'Payment confirmed',
        body:
          updatedInvoice?.payment_status === 'paid'
            ? `We have confirmed ৳${amount}. Your plan now runs to ${subscription?.expiry_date || 'the new expiry date'}.`
            : `We have confirmed ৳${amount}. ৳${planBalanceOf(updatedInvoice)} still outstanding.`,
        url: '/building#plan',
        tag: `building-claim-${requestId}`,
      });

      return NextResponse.json(
        { success: true, data: { request: closed, invoice: updatedInvoice, subscription } },
        { status: 200 }
      );
    }

    // ---- Ordinary status / note work.
    const patch: Record<string, any> = {};

    if (body.status !== undefined) {
      const status = String(body.status);
      if (!VALID_STATUS.includes(status)) {
        return NextResponse.json({ success: false, error: 'Unknown status.' }, { status: 400 });
      }
      // Rejecting without saying why leaves the building staring at a dead request with no
      // recourse — the same rule the owner payment queue enforces.
      if (status === 'rejected' && !(adminNotes ?? existing.admin_notes)) {
        return NextResponse.json(
          { success: false, error: 'Add a note explaining the rejection — the building can read it.' },
          { status: 400 }
        );
      }
      patch.status = status;
      patch.reviewed_by = request.headers.get('x-rentmaster-uid');
      patch.reviewed_at = new Date().toISOString();
    }
    if (adminNotes !== undefined) patch.admin_notes = adminNotes;

    if (!Object.keys(patch).length) {
      return NextResponse.json({ success: false, error: 'Nothing to update.' }, { status: 400 });
    }
    patch.updated_at = new Date().toISOString();

    const { data: updated, error } = await supabaseAdminEngine
      .from('building_plan_requests')
      .update(patch)
      .eq('id', requestId)
      .select('*')
      .single();
    if (error) throw error;

    // Only a decision is worth a notification. Moving a request to 'in_progress' is our
    // bookkeeping, and pushing every internal step would train them to ignore the channel.
    if (patch.status === 'rejected' || patch.status === 'closed') {
      void notifyOwner({
        userId: existing.admin_id,
        title: patch.status === 'rejected' ? 'Request declined' : 'Request closed',
        body: String(patch.admin_notes ?? existing.admin_notes ?? 'Open your Plan tab for the details.').slice(0, 180),
        url: '/building#plan',
        tag: `building-request-${requestId}`,
      });
    }

    return NextResponse.json({ success: true, data: updated }, { status: 200 });
  } catch (err) {
    return apiError(request, err);
  }
}
