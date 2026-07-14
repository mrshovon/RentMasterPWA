import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { supabaseAdminEngine } from '../../../../lib/supabase-server';
import { assertOwnerCanWrite, resolveOwnerSubscription, assertItemEnabled } from '../../../../lib/subscription';
import { sendPushToUsers } from '../../../../lib/push-send';
import crypto from 'crypto';


// ====================================================================
// 🚀 INVOICE FETCH ENGINE: RELATIONAL QUERY GET REQUEST ROUTE LAYER
// ====================================================================
export async function GET(request: NextRequest) {
  try {
    // 1. Identity Extractions from Secure Central Downstream Middleware
    const ownerId = request.headers.get('x-rentmaster-uid');
    if (!ownerId || ownerId === 'YOUR_ACTUAL_USER_UUID_FROM_DATABASE') {
      return NextResponse.json({ error: 'Context matching identity extraction missing.' }, { status: 400 });
    }

    // 2. Fetch records with relational outer inner tracking joins mapping metrics
    const { data: billingLedgerRecords, error: ledgerFetchException } = await supabaseAdminEngine
      .from('billing_ledgers')
      .select(`
        *,
        properties:property_id (name),
        tenants:tenant_id (name,phone)
      `)
      .eq('created_by_owner', ownerId)
      .order('created_at', { ascending: false });

    if (ledgerFetchException) {
      console.error('Supabase Core Billing Fetch Error:', ledgerFetchException);
      return NextResponse.json({ error: ledgerFetchException.message }, { status: 500 });
    }

    // 3. Dispatch structured clean stream matrix back to UI Consumer Client
    return NextResponse.json({ 
      success: true, 
      count: billingLedgerRecords?.length || 0,
      data: billingLedgerRecords 
    }, { status: 200 });

  } catch (runtimeExceptionCatch: any) {
    console.error('Fatal Pipeline Execution Billing GET Route Crash:', runtimeExceptionCatch);
    return NextResponse.json({ error: runtimeExceptionCatch.message || 'Fatal Server Logic Exception.' }, { status: 500 });
  }
}

// ====================================================================
// 🚀 INVOICE REGISTRY GENERATION ENGINE: UPDATED EXTRA CHARGES METRICS
// ====================================================================
export async function POST(request: NextRequest) {
  try {
    const ownerId = request.headers.get('x-rentmaster-uid');
    const role = request.headers.get('x-rentmaster-role');
    if (!ownerId || ownerId === 'YOUR_ACTUAL_USER_UUID_FROM_DATABASE') {
      return NextResponse.json({ error: 'Context matching identity extraction missing.' }, { status: 400 });
    }

    const guard = await assertOwnerCanWrite(role, ownerId);
    if (!guard.ok) return NextResponse.json(guard.body, { status: guard.status });

    const bodyPayload = await request.json();
    const { 
      tenantId, 
      propertyId, 
      billingMonth, 
      rentAmount, 
      serviceCharge, 
      extraCharge,         // 🚀 UPDATED FIELD PARAMETER TRACKER
      extraChargeRemarks,  // 🚀 FRESH STRUCTURAL REMARKS FIELD COLUMN TEXT
      discount 
    } = bodyPayload;

    // 1. Structural Column Parameter Validation check
    if (!tenantId || !propertyId || !billingMonth || !rentAmount) {
      return NextResponse.json({ error: 'Validation missing compulsory database column payload indicators.' }, { status: 400 });
    }

    // Can't bill a disabled (over-limit) tenant/property.
    const sub = await resolveOwnerSubscription(ownerId);
    const itemGuard = await assertItemEnabled(role, ownerId, sub, { tenantId, propertyId });
    if (!itemGuard.ok) return NextResponse.json(itemGuard.body, { status: itemGuard.status });

    // 2. Perform financial ledger calculation parsing variables matrices with fresh extra charges
    const rent = parseFloat(rentAmount);
    const service = serviceCharge ? parseFloat(serviceCharge) : 0;
    const extra = extraCharge ? parseFloat(extraCharge) : 0;
    const disc = discount ? parseFloat(discount) : 0;
    
    // Exact Total Payable dynamic field tracking update formula
    const totalPayable = (rent + service + extra) - disc;
    const billingId = crypto.randomUUID();

    // 3. Register financial transaction data blocks inside public.billing_ledgers
    const { data: billingRecord, error: billingInsertError } = await supabaseAdminEngine
      .from('billing_ledgers')
      .insert([
        {
          id: billingId,
          tenant_id: tenantId,
          property_id: propertyId,
          billing_month: billingMonth, // Format tracking: "YYYY-MM" (e.g., "2026-06")
          rent_amount: rent,
          service_charge: service,
          extra_charge: extra,                         // 🚀 FIXED FIELD INSIDE DATABASE CELL MAP
          extra_charge_remarks: extraChargeRemarks || null, // 🚀 INJECTED REMARKS FIELD TO TABLE MATRIX
          discount: disc,
          total_payable: totalPayable,
          payment_status: 'unpaid', 
          created_by_owner: ownerId
        }
      ])
      .select()
      .single();

    if (billingInsertError) {
      console.error('Supabase Billing Ledger Write Error:', billingInsertError);
      return NextResponse.json({ error: billingInsertError.message }, { status: 500 });
    }

    // Fire-and-forget Web Push to the tenant being billed (never fail the response on push).
    try {
      await sendPushToUsers([tenantId], {
        title: 'New invoice',
        body: `Your bill for ${billingMonth} is ৳${totalPayable}.`,
        url: '/tenant',
        tag: `invoice-${billingId}`,
      });
    } catch (pushErr) {
      console.error('[billing] push dispatch failed (non-fatal):', pushErr);
    }

    return NextResponse.json({ success: true, data: billingRecord }, { status: 201 });

  } catch (runtimeExceptionCatch: any) {
    console.error('Fatal Pipeline Execution Billing Core Route Crash:', runtimeExceptionCatch);
    return NextResponse.json({ error: runtimeExceptionCatch.message || 'Fatal Server Logic Exception.' }, { status: 500 });
  }
}