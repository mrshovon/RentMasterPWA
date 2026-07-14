import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { supabaseAdminEngine } from '../../../../../lib/supabase-server';
import { assertOwnerCanWrite, resolveOwnerSubscription, assertItemEnabled } from '../../../../../lib/subscription';
import { sendPushToUsers } from '../../../../../lib/push-send';
import crypto from 'crypto';

// ==============================================================================
// 🚀 TRANSACTION MUTATOR: INDIVIDUAL INVOICE LEDGER STATUS STATUS PATCH HANDLER
// ==============================================================================
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> } // Next.js standard async route dynamic params type matching layer
) {
  try {
    // 1. Resolve active dynamic entity tracking parameter ID
    const { id: billingRecordId } = await params;
    
    // 2. Extracted authenticated identity (owner via uid; tenant via tenant-id header).
    const ownerId = request.headers.get('x-rentmaster-uid');
    const callerTenantId = request.headers.get('x-rentmaster-tenant-id');
    const role = request.headers.get('x-rentmaster-role');

    if (!ownerId && !callerTenantId) {
      return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 });
    }
    if (!billingRecordId) {
      return NextResponse.json({ error: 'Dynamic route validation criteria missing individual row identifier.' }, { status: 400 });
    }

    // Owner write-lock (no-op for tenant callers, who only mark bills as 'sent').
    const guard = await assertOwnerCanWrite(role, ownerId);
    if (!guard.ok) return NextResponse.json(guard.body, { status: guard.status });

    // Owner can't toggle a bill belonging to a disabled (over-limit) tenant.
    if (role === 'owner') {
      const { data: led } = await supabaseAdminEngine
        .from('billing_ledgers').select('tenant_id, property_id').eq('id', billingRecordId).maybeSingle();
      if (led) {
        const sub = await resolveOwnerSubscription(ownerId);
        const itemGuard = await assertItemEnabled(role, ownerId, sub, { tenantId: led.tenant_id, propertyId: led.property_id });
        if (!itemGuard.ok) return NextResponse.json(itemGuard.body, { status: itemGuard.status });
      }
    }

    // 3. Extract parameter updates request body JSON
    const bodyPayload = await request.json();
    const { paymentStatus } = bodyPayload; // Expected parameters: 'paid' | 'unpaid' | 'sent'

    if (!paymentStatus || !['paid', 'unpaid','sent'].includes(paymentStatus)) {
      return NextResponse.json({ error: 'Invalid mutation payload criteria. Value must strictly match paid, unpaid or sent configurations.' }, { status: 400 });
    }

    // 3b. Tenant governance: a tenant may only flag their OWN bill as 'sent'.
    if (callerTenantId && paymentStatus !== 'sent') {
      return NextResponse.json({ error: 'Tenants may only mark a bill as sent; owner confirmation is required for other states.' }, { status: 403 });
    }

    // 4. Update the ledger, scoped strictly to the caller's own data:
    //    - tenant callers: only their own bill (tenant_id), never another tenant's;
    //    - owner callers: only bills they created (created_by_owner).
    let mutationQuery = supabaseAdminEngine
      .from('billing_ledgers')
      .update({ payment_status: paymentStatus })
      .eq('id', billingRecordId);
    if (callerTenantId) {
      mutationQuery = mutationQuery.eq('tenant_id', callerTenantId);
    } else {
      mutationQuery = mutationQuery.eq('created_by_owner', ownerId);
    }
    const { data: updatedLedgerRecord, error: mutationDatabaseException } = await mutationQuery
      .select('*, tenants:tenant_id (name)')
      .single();

    if (mutationDatabaseException) {
      console.error('Supabase Mutation Ledger Registry Fail:', mutationDatabaseException);
      return NextResponse.json({ error: mutationDatabaseException.message }, { status: 500 });
    }

    // 4b. Side-effect: when a TENANT flags rent as 'sent', drop an in-app notice into
    // the owner's feed (owner notices are surfaced by sender_id === their uid).
    if (paymentStatus === 'sent' && callerTenantId && updatedLedgerRecord) {
      const tenantName = (updatedLedgerRecord as any).tenants?.name || 'A tenant';
      const monthLabel = updatedLedgerRecord.billing_month;
      const amount = updatedLedgerRecord.total_payable;
      const { error: noticeError } = await supabaseAdminEngine
        .from('notices')
        .insert([
          {
            id: crypto.randomUUID(),
            sender_type: 'tenant',
            sender_id: updatedLedgerRecord.created_by_owner, // routes into the owner's notice feed
            target_scope: 'individual_owner',
            target_tenant_id: updatedLedgerRecord.tenant_id,
            title: 'Rent payment marked as sent',
            content: `${tenantName} marked the rent for ${monthLabel} (৳${amount}) as sent. Please verify the payment and confirm receipt.`,
          },
        ]);
      if (noticeError) {
        // Non-fatal: the status change already succeeded; just log the notify miss.
        console.error('Owner notice dispatch warning:', noticeError.message);
      }

      // Same event, second channel: buzz the owner's device so they can verify the payment.
      try {
        await sendPushToUsers([updatedLedgerRecord.created_by_owner], {
          title: 'Rent marked as sent',
          body: `${tenantName} says they've sent ৳${amount} for ${monthLabel}. Please confirm receipt.`,
          url: '/owner',
          tag: `bill-sent-${billingRecordId}`,
        });
      } catch (pushErr) {
        console.error('[billing] owner push dispatch failed (non-fatal):', pushErr);
      }
    }

    // 4b-ii. Owner confirmed the payment — tell the tenant their bill is settled.
    if (paymentStatus === 'paid' && ownerId && updatedLedgerRecord) {
      try {
        await sendPushToUsers([updatedLedgerRecord.tenant_id], {
          title: 'Payment confirmed',
          body: `Your rent for ${updatedLedgerRecord.billing_month} (৳${updatedLedgerRecord.total_payable}) is marked paid. Receipt available.`,
          url: '/tenant',
          tag: `bill-paid-${billingRecordId}`,
        });
      } catch (pushErr) {
        console.error('[billing] tenant push dispatch failed (non-fatal):', pushErr);
      }
    }

    // 4c. Best-effort payment timestamp for receipts (requires the billing_ledgers.paid_at
    // migration). If the column is absent the status change above still succeeds.
    const paidAtValue = paymentStatus === 'paid' ? new Date().toISOString() : null;
    const { error: paidAtError } = await supabaseAdminEngine
      .from('billing_ledgers')
      .update({ paid_at: paidAtValue })
      .eq('id', billingRecordId);
    if (paidAtError) {
      console.warn('paid_at not updated (run the paid_at migration to enable late detection):', paidAtError.message);
    } else if (updatedLedgerRecord) {
      (updatedLedgerRecord as any).paid_at = paidAtValue;
    }

    // 5. Return mutated clean state context mapping back to consumer client dashboard grids
    return NextResponse.json({
      success: true,
      message: `Invoice transactional state updated safely inside database clusters towards '${paymentStatus}'.`,
      data: updatedLedgerRecord
    }, { status: 200 });

  } catch (runtimeExceptionCatch: any) {
    console.error('Fatal Pipeline Execution Dynamic Billing PATCH Route Crash:', runtimeExceptionCatch);
    return NextResponse.json({ error: runtimeExceptionCatch.message || 'Fatal Server Logic Exception.' }, { status: 500 });
  }
}