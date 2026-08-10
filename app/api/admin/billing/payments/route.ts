import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { supabaseAdminEngine } from '@/lib/supabase-server';
import { assertOwnerCanWrite, resolveOwnerSubscription, assertItemEnabled } from '@/lib/subscription';
import { ownerId, ownedLedger, recalcLedger, PAYMENT_METHODS, BILLING_PAYMENT_SELECT } from '@/lib/billing';
import { bookAutoTransaction } from '@/lib/accounts';
import crypto from 'crypto';
import { apiError } from '@/lib/api-response';

// =====================================================================================
// 🧾 RENT PAYMENTS (INSTALLMENTS) — OWNER writes, TENANT reads
// GET  -> the payment log. Owner: everything they own (optional ?ledgerId=). Tenant: their own.
// POST -> record one payment against an invoice.
//
// Rent is often paid in parts — ৳5,000 now, the rest later. Each part is one row here, and the
// parent invoice's amount_paid / payment_status / paid_at are re-derived by recalcLedger().
// Nothing else may write those three columns.
// =====================================================================================

export async function GET(request: NextRequest) {
  try {
    const uid = ownerId(request);
    const callerTenantId = request.headers.get('x-rentmaster-tenant-id');
    if (!uid && !callerTenantId) {
      return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 });
    }

    let query = supabaseAdminEngine
      .from('billing_payments')
      .select(BILLING_PAYMENT_SELECT)
      // Ascending: the receipt numbers these 1st, 2nd, 3rd in the order the money arrived.
      .order('paid_on', { ascending: true });

    // Scope to the caller's own data. A tenant is never trusted with an owner-wide read.
    if (callerTenantId) {
      query = query.eq('tenant_id', callerTenantId);
    } else {
      query = query.eq('owner_id', uid as string);
      const ledgerId = request.nextUrl.searchParams.get('ledgerId');
      if (ledgerId) query = query.eq('ledger_id', ledgerId);
    }

    const { data, error } = await query;
    if (error) throw error;

    return NextResponse.json({ success: true, count: data?.length || 0, data: data || [] }, { status: 200 });
  } catch (err) {
    return apiError(request, err);
  }
}

export async function POST(request: NextRequest) {
  try {
    // Recording money received is an owner action only — a tenant may still just flag a bill
    // as 'sent' via PATCH /api/admin/billing/[id]. Checked before the uid test so a tenant gets
    // a truthful 403 rather than "identity missing" (the middleware injects no uid for them).
    if (request.headers.get('x-rentmaster-tenant-id')) {
      return NextResponse.json({ error: 'Only the owner can record a payment.' }, { status: 403 });
    }

    const uid = ownerId(request);
    if (!uid) return NextResponse.json({ error: 'Context matching identity missing.' }, { status: 400 });

    const role = request.headers.get('x-rentmaster-role');

    const guard = await assertOwnerCanWrite(role, uid);
    if (!guard.ok) return NextResponse.json(guard.body, { status: guard.status });

    const body = await request.json();
    const ledgerId = String(body.ledgerId || '').trim();
    const amount = Number(body.amount);
    const paidOn = String(body.paidOn || '').slice(0, 10);
    const method = PAYMENT_METHODS.includes(body.method) ? body.method : 'cash';
    const note = String(body.note ?? '').trim() || null;

    if (!ledgerId) {
      return NextResponse.json({ success: false, error: 'An invoice is required.' }, { status: 400 });
    }
    if (!Number.isFinite(amount) || amount <= 0) {
      return NextResponse.json({ success: false, error: 'Enter an amount greater than zero.' }, { status: 400 });
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(paidOn) || Number.isNaN(Date.parse(paidOn))) {
      return NextResponse.json({ success: false, error: 'A valid payment date is required.' }, { status: 400 });
    }
    if (paidOn > new Date().toISOString().slice(0, 10)) {
      return NextResponse.json({ success: false, error: 'Payment date cannot be in the future.' }, { status: 400 });
    }

    // The invoice must be this owner's — never trust an id from the body.
    const ledger = await ownedLedger(ledgerId, uid);
    if (!ledger) {
      return NextResponse.json({ success: false, error: 'Invoice not found.' }, { status: 404 });
    }

    // Same gate as the status PATCH: a bill belonging to an over-limit tenant stays untouchable.
    const sub = await resolveOwnerSubscription(uid);
    const itemGuard = await assertItemEnabled(role, uid, sub, {
      tenantId: ledger.tenant_id, propertyId: ledger.property_id,
    });
    if (!itemGuard.ok) return NextResponse.json(itemGuard.body, { status: itemGuard.status });

    const { data: payment, error: insertError } = await supabaseAdminEngine
      .from('billing_payments')
      .insert([{
        id: crypto.randomUUID(),
        ledger_id: ledgerId,
        owner_id: uid,
        tenant_id: ledger.tenant_id,
        amount,
        paid_on: paidOn,
        method,
        note,
      }])
      .select(BILLING_PAYMENT_SELECT)
      .single();

    if (insertError) {
      return apiError(request, insertError);
    }

    const updatedLedger = await recalcLedger(ledgerId);

    // Accounts automation (best-effort): book THIS INSTALLMENT as income on ITS OWN date, so
    // split and back-dated rent lands in the month it was actually received. source_ref is the
    // payment id, not the invoice id — that is what lets one invoice carry several rows.
    // Never let a bookkeeping side-effect fail the payment that already succeeded.
    try {
      await bookAutoTransaction(uid, {
        direction: 'income',
        amount,
        propertyId: ledger.property_id ?? null,
        category: 'Rent',
        txnDate: paidOn,
        source: 'billing',
        sourceRef: payment.id,
      });
    } catch (acctErr) {
      console.error('[billing/payments] accounts automation failed (non-fatal):', acctErr);
    }

    return NextResponse.json({ success: true, data: payment, ledger: updatedLedger }, { status: 201 });
  } catch (err) {
    return apiError(request, err);
  }
}
