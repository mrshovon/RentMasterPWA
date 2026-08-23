import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { supabaseAdminEngine } from '../../../../../lib/supabase-server';
import { assertOwnerCanWrite, resolveOwnerSubscription, assertItemEnabled } from '../../../../../lib/subscription';
import { sendPushToUsers } from '../../../../../lib/push-send';
import { bookAutoTransaction, reverseAutoTransaction } from '../../../../../lib/accounts';
import { ownedLedger, recalcLedger, balanceOf, SETTLED_INVOICE_ERROR } from '../../../../../lib/billing';
import crypto from 'crypto';
import { apiError } from '@/lib/api-response';

// ==============================================================================
// 🚀 TRANSACTION MUTATOR: INDIVIDUAL INVOICE LEDGER STATUS STATUS PATCH HANDLER
//
// Since rent can be paid in installments, 'paid' and 'unpaid' are no longer stored directly —
// they are shorthands for editing the billing_payments log, after which recalcLedger() derives
// the real status:
//   'paid'   -> record one payment covering whatever balance is left ("settle in full")
//   'unpaid' -> delete every recorded payment ("I entered this by mistake")
// Only 'sent' is still a status the caller writes, because it is a tenant's claim about money
// rather than a record of money received. 'partial' is never accepted here — it is derived.
//
// Once the invoice reaches 'paid' it is FROZEN: every caller, owner or tenant, gets a 409 from
// here on. See SETTLED_INVOICE_ERROR in lib/billing.ts and the sibling guards in the two
// billing_payments routes — a settled invoice is a financial record, not a toggle.
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

    // 2b. The invoice as it stands, scoped to the caller so neither role can probe another
    // account's row. Read for BOTH roles now — the settled-invoice guard below applies to the
    // tenant's 'sent' claim just as much as to the owner's status buttons.
    const ledgerLookup = supabaseAdminEngine
      .from('billing_ledgers')
      .select('tenant_id, property_id, payment_status')
      .eq('id', billingRecordId);
    const { data: currentLedger } = await (callerTenantId
      ? ledgerLookup.eq('tenant_id', callerTenantId)
      : ledgerLookup.eq('created_by_owner', ownerId as string)
    ).maybeSingle();
    const previousPaymentStatus: string | null = currentLedger?.payment_status ?? null;

    // Owner can't toggle a bill belonging to a disabled (over-limit) tenant.
    if (role === 'owner' && currentLedger) {
      const sub = await resolveOwnerSubscription(ownerId);
      const itemGuard = await assertItemEnabled(role, ownerId, sub, {
        tenantId: currentLedger.tenant_id, propertyId: currentLedger.property_id,
      });
      if (!itemGuard.ok) return NextResponse.json(itemGuard.body, { status: itemGuard.status });
    }

    // 2c. A settled invoice is FROZEN for everyone — the owner cannot walk it back to unpaid/sent
    // and the tenant cannot re-flag it as sent. Checked before the body is even parsed, so no
    // status write, payment row or notification can slip past it.
    if (previousPaymentStatus === 'paid') {
      return NextResponse.json({ error: SETTLED_INVOICE_ERROR }, { status: 409 });
    }

    // 3. Extract parameter updates request body JSON
    const bodyPayload = await request.json();
    const { paymentStatus } = bodyPayload; // Expected parameters: 'paid' | 'unpaid' | 'sent'

    if (!paymentStatus || !['paid', 'unpaid','sent'].includes(paymentStatus)) {
      return NextResponse.json({ error: 'Invalid mutation payload criteria. Value must strictly match paid, unpaid or sent configurations.' }, { status: 400 });
    }

    // 3a. Optional owner-supplied payment date ('YYYY-MM-DD'). This is what makes back-dated entry
    // honest: without it, an invoice for an earlier month recorded today looks LATE on the receipt
    // even though the tenant paid on time. Absent -> today, so older clients keep working.
    // Tenants never reach this (they're pinned to 'sent' below).
    const todayIsoDay = new Date().toISOString().slice(0, 10);
    const paidOn = bodyPayload.paidOn ? String(bodyPayload.paidOn).slice(0, 10) : '';
    if (paidOn && !callerTenantId) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(paidOn) || Number.isNaN(Date.parse(paidOn))) {
        return NextResponse.json({ error: 'Invalid payment date. Expected YYYY-MM-DD.' }, { status: 400 });
      }
      if (paidOn > todayIsoDay) {
        return NextResponse.json({ error: 'Payment date cannot be in the future.' }, { status: 400 });
      }
    }
    const effectivePaidOn = (!callerTenantId && paidOn) ? paidOn : todayIsoDay;

    // 3b. Tenant governance: a tenant may only flag their OWN bill as 'sent'.
    if (callerTenantId && paymentStatus !== 'sent') {
      return NextResponse.json({ error: 'Tenants may only mark a bill as sent; owner confirmation is required for other states.' }, { status: 403 });
    }

    // 4. Apply the change. 'paid' and 'unpaid' go through the payment log so the derived status,
    // the amount paid and the receipt's payment history can never disagree with each other.
    let updatedLedgerRecord: any = null;

    if (!callerTenantId && (paymentStatus === 'paid' || paymentStatus === 'unpaid')) {
      const ledger = await ownedLedger(billingRecordId, ownerId as string);
      if (!ledger) {
        return NextResponse.json({ error: 'Invoice not found.' }, { status: 404 });
      }

      if (paymentStatus === 'paid') {
        // Settle in full: one payment for whatever is still owed. Already settled -> nothing to
        // add, rather than a duplicate row that would double the owner's income.
        const balance = balanceOf(ledger);
        if (balance > 0) {
          const { data: payment, error: payErr } = await supabaseAdminEngine
            .from('billing_payments')
            .insert([{
              id: crypto.randomUUID(),
              ledger_id: billingRecordId,
              owner_id: ownerId,
              tenant_id: ledger.tenant_id,
              amount: balance,
              paid_on: effectivePaidOn,
              method: 'cash',
              note: null,
            }])
            .select('id')
            .single();
          if (payErr) {
            return apiError(request, payErr);
          }
          try {
            await bookAutoTransaction(ownerId as string, {
              direction: 'income',
              amount: balance,
              propertyId: ledger.property_id ?? null,
              category: 'Rent',
              txnDate: effectivePaidOn,
              source: 'billing',
              sourceRef: payment.id,
            });
          } catch (acctErr) {
            console.error('[billing] accounts automation failed (non-fatal):', acctErr);
          }
        }
      } else {
        // Clear the record: drop every installment, reversing each one's income row.
        const { data: existing } = await supabaseAdminEngine
          .from('billing_payments')
          .select('id')
          .eq('ledger_id', billingRecordId)
          .eq('owner_id', ownerId as string);
        for (const p of existing || []) {
          try {
            await reverseAutoTransaction(ownerId as string, 'billing', p.id);
          } catch (acctErr) {
            console.error('[billing] accounts reversal failed (non-fatal):', acctErr);
          }
        }
        const { error: delErr } = await supabaseAdminEngine
          .from('billing_payments')
          .delete()
          .eq('ledger_id', billingRecordId)
          .eq('owner_id', ownerId as string);
        if (delErr) {
          return apiError(request, delErr);
        }
      }

      updatedLedgerRecord = await recalcLedger(billingRecordId);
    } else {
      // 'sent' — a claim, not a record of money. Written directly, scoped strictly to the
      // caller's own data: tenant callers only their own bill, owners only bills they created.
      let mutationQuery = supabaseAdminEngine
        .from('billing_ledgers')
        .update({ payment_status: paymentStatus })
        .eq('id', billingRecordId);
      if (callerTenantId) {
        mutationQuery = mutationQuery.eq('tenant_id', callerTenantId);
      } else {
        mutationQuery = mutationQuery.eq('created_by_owner', ownerId);
      }
      const { data, error: mutationDatabaseException } = await mutationQuery
        .select('*, tenants:tenant_id (name)')
        .single();

      if (mutationDatabaseException) {
        return apiError(request, mutationDatabaseException);
      }
      updatedLedgerRecord = data;
    }

    // 4b. Side-effect: when a TENANT flags rent as 'sent', drop an in-app notice into
    // the owner's feed (owner notices are surfaced by sender_id === their uid).
    if (paymentStatus === 'sent' && callerTenantId && updatedLedgerRecord) {
      const tenantName = (updatedLedgerRecord as any).tenants?.name || 'A tenant';
      const monthLabel = updatedLedgerRecord.billing_month;
      // What they still owe, not the invoice total — the owner may already have recorded part of it.
      const amount = balanceOf(updatedLedgerRecord);
      const { error: noticeError } = await supabaseAdminEngine
        .from('notices')
        .insert([
          {
            id: crypto.randomUUID(),
            sender_type: 'tenant',
            sender_id: updatedLedgerRecord.created_by_owner, // routes into the owner's notice feed
            target_scope: 'individual_owner',
            // Names the addressee explicitly. sender_id already routes this into the owner's
            // feed, but 'individual_owner' now means "target_owner_id is who this is for"
            // (see ADD_NOTICE_TARGETS.sql — the DB constraint requires it).
            target_owner_id: updatedLedgerRecord.created_by_owner,
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

    // 4b-ii. Owner confirmed the payment — tell the tenant their bill is settled. No "already
    // paid" test is needed any more: 2c turns an already-settled invoice away with a 409, so
    // reaching here at all means this is the first time it settled.
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

    // NOTE: paid_at and the Accounts income row are NOT written here. recalcLedger() owns the
    // former and the payment log owns the latter — one income row per installment, booked on that
    // installment's own date. See lib/billing.ts.

    // 5. Return mutated clean state context mapping back to consumer client dashboard grids
    return NextResponse.json({
      success: true,
      message: `Invoice transactional state updated safely inside database clusters towards '${paymentStatus}'.`,
      data: updatedLedgerRecord
    }, { status: 200 });

  } catch (runtimeExceptionCatch) {
    return apiError(request, runtimeExceptionCatch);
  }
}