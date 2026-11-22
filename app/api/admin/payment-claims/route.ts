import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import crypto from 'crypto';
import { supabaseAdminEngine } from '@/lib/supabase-server';
import { apiError } from '@/lib/api-response';
import { SETTLED_INVOICE_ERROR } from '@/lib/billing';
import {
  CLAIM_SOURCES, normalizeClaimInput, pendingClaimFor,
  listClaims, notifyClaim, type ClaimSource, type PaymentClaim,
} from '@/lib/payment-claims';

// =====================================================================================
// 🧾 PAYMENT CLAIMS — payer submits, payee reviews
//
// GET  ?scope=payer|payee[&source=rent|service_charge]  -> claims for this identity
// POST { source, refId, method, reference?, note? }      -> claim "I paid you this way"
//
// A claim is NOT money. It never writes billing_payments, building_service_payments or an
// account_transactions row. Rent additionally flips the ledger to its existing 'sent' status;
// service charge has no such DB status, so the open claim IS what the UI shows as awaiting.
//
// Identity comes from the middleware headers only. Tenants may claim RENT against their own
// ledger; owners (including flat owners) may claim SERVICE CHARGE against their own invoice.
// =====================================================================================

export async function GET(request: NextRequest) {
  try {
    const uid = request.headers.get('x-rentmaster-uid');
    const tenantId = request.headers.get('x-rentmaster-tenant-id');
    if (!uid && !tenantId) {
      return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 });
    }
    const scope = new URL(request.url).searchParams.get('scope') === 'payer' ? 'payer' : 'payee';
    const sourceParam = new URL(request.url).searchParams.get('source');
    const source = CLAIM_SOURCES.includes(sourceParam as ClaimSource) ? sourceParam as ClaimSource : undefined;

    let claims;
    try {
      claims = await listClaims({
        ...(scope === 'payer' ? { payerId: tenantId || uid } : { payeeId: uid }),
        ...(source ? { source } : {}),
      });
    } catch {
      // Before ADD_PAYMENT_CLAIMS.sql: an empty queue is the safe, non-breaking answer.
      return NextResponse.json({
        success: true, provisioned: false, count: 0, data: [],
        notice: 'Payment claims are not provisioned yet. Run ADD_PAYMENT_CLAIMS.sql in Supabase.',
      }, { status: 200 });
    }

    // Enrich in two batched queries rather than one round trip per row — the payee work queue can
    // hold claims across many invoices, and a N+1 here is exactly the slow screen nobody uses.
    const byId = new Map<string, PaymentClaim>();
    for (const c of claims) byId.set(c.id, { ...c, refLabel: null, amount: null });
    const rentIds = claims.filter((c) => c.source === 'rent').map((c) => c.ref_id);
    const serviceIds = claims.filter((c) => c.source === 'service_charge').map((c) => c.ref_id);

    if (rentIds.length) {
      const { data } = await supabaseAdminEngine
        .from('billing_ledgers').select('id, billing_month, total_payable, amount_paid')
        .in('id', rentIds);
      for (const row of data || []) {
        for (const c of claims) {
          if (c.source === 'rent' && c.ref_id === row.id) {
            const item = byId.get(c.id)!;
            item.refLabel = row.billing_month;
            item.amount = Math.max(0, Number(row.total_payable || 0) - Number(row.amount_paid || 0));
          }
        }
      }
    }
    if (serviceIds.length) {
      const { data } = await supabaseAdminEngine
        .from('building_service_invoices').select('id, billing_month, total_payable, amount_paid')
        .in('id', serviceIds);
      for (const row of data || []) {
        for (const c of claims) {
          if (c.source === 'service_charge' && c.ref_id === row.id) {
            const item = byId.get(c.id)!;
            item.refLabel = row.billing_month;
            item.amount = Math.max(0, Number(row.total_payable || 0) - Number(row.amount_paid || 0));
          }
        }
      }
    }
    return NextResponse.json({ success: true, count: claims.length, data: [...byId.values()] }, { status: 200 });
  } catch (err) {
    return apiError(request, err);
  }
}

export async function POST(request: NextRequest) {
  try {
    const uid = request.headers.get('x-rentmaster-uid');
    const tenantId = request.headers.get('x-rentmaster-tenant-id');
    if (!uid && !tenantId) {
      return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 });
    }

    const body = await request.json();
    const source = body?.source as ClaimSource;
    const refId = String(body?.refId || '');
    if (!CLAIM_SOURCES.includes(source) || !refId) {
      return NextResponse.json({ error: 'A valid source and invoice are required.' }, { status: 400 });
    }
    if (tenantId && source !== 'rent') {
      return NextResponse.json({ error: 'Tenants may only submit rent payment claims.' }, { status: 403 });
    }
    if (!tenantId && source !== 'service_charge') {
      return NextResponse.json({ error: 'Rent claims are submitted from the tenant portal.' }, { status: 403 });
    }

    const input = normalizeClaimInput(body);
    if (!input.ok) return NextResponse.json({ error: input.error }, { status: 400 });

    if (await pendingClaimFor(source, refId)) {
      return NextResponse.json({
        success: false, error: 'A payment is already awaiting confirmation for this invoice.',
        code: 'ALREADY_PENDING',
      }, { status: 409 });
    }

    let payeeId: string;
    let payerName: string;
    let refLabel: string;
    let amount: number;

    if (source === 'rent') {
      const { data: ledger } = await supabaseAdminEngine
        .from('billing_ledgers')
        .select('id, tenant_id, created_by_owner, billing_month, total_payable, amount_paid, payment_status')
        .eq('id', refId).eq('tenant_id', tenantId).maybeSingle();
      if (!ledger) return NextResponse.json({ error: 'Invoice not found.' }, { status: 404 });
      if (ledger.payment_status === 'paid') {
        return NextResponse.json({ error: SETTLED_INVOICE_ERROR }, { status: 409 });
      }
      payeeId = String(ledger.created_by_owner);
      const { data: tenant } = await supabaseAdminEngine
        .from('tenants').select('name').eq('id', tenantId).maybeSingle();
      payerName = tenant?.name || 'A tenant';
      refLabel = String(ledger.billing_month || '');
      amount = Math.max(0, Number(ledger.total_payable || 0) - Number(ledger.amount_paid || 0));

      // Rent already has a 'sent' status, but it is flipped only AFTER the claim row lands —
      // otherwise a failed insert (e.g. the SQL has not been run) would leave the ledger saying
      // "sent" with nothing for the owner to look at. See the write below.
    } else {
      const { data: invoice } = await supabaseAdminEngine
        .from('building_service_invoices')
        .select('id, owner_id, admin_id, billing_month, total_payable, amount_paid, payment_status')
        .eq('id', refId).eq('owner_id', uid).maybeSingle();
      if (!invoice) return NextResponse.json({ error: 'Invoice not found.' }, { status: 404 });
      if (invoice.payment_status === 'paid') {
        return NextResponse.json({ error: 'This invoice is settled and can no longer be changed.' }, { status: 409 });
      }
      payeeId = String(invoice.admin_id);
      const { data: profile } = await supabaseAdminEngine
        .from('user_profiles').select('name').eq('id', uid).maybeSingle();
      payerName = profile?.name || 'A flat owner';
      refLabel = String(invoice.billing_month || '');
      amount = Math.max(0, Number(invoice.total_payable || 0) - Number(invoice.amount_paid || 0));
      // NO invoice status write here: the DB CHECK forbids 'sent', and recalcBuildingInvoice()
      // remains the only writer of amount_paid / payment_status / paid_at.
    }

    let claim: any;
    try {
      const inserted = await supabaseAdminEngine
        .from('payment_claims')
        .insert({
          id: crypto.randomUUID(),
          source,
          ref_id: refId,
          payer_id: tenantId || uid,
          payee_id: payeeId,
          method: input.method,
          reference: input.reference,
          note: input.note,
          status: 'pending',
        })
        .select('*')
        .single();
      if (inserted.error) throw inserted.error;
      claim = inserted.data;
    } catch (err: any) {
      if (err?.code === 'PGRST205' || err?.code === '42P01') {
        return NextResponse.json({
          success: false,
          error: 'Payment claims are not provisioned yet. Run ADD_PAYMENT_CLAIMS.sql in Supabase.',
          code: 'CLAIMS_NOT_PROVISIONED',
        }, { status: 409 });
      }
      throw err;
    }

    if (source === 'rent') {
      const { error: statusErr } = await supabaseAdminEngine
        .from('billing_ledgers')
        .update({ payment_status: 'sent' })
        .eq('id', refId).eq('tenant_id', tenantId).neq('payment_status', 'paid');
      if (statusErr) throw statusErr;
    }

    // Non-fatal and independent. The claim is already recorded; a notice failure must not make
    // the payer think their submission failed.
    void notifyClaim({ source, payeeId, payerName, refLabel, amount });

    return NextResponse.json({
      success: true,
      message: 'Payment details sent — awaiting confirmation.',
      data: claim,
    }, { status: 201 });
  } catch (err) {
    return apiError(request, err);
  }
}
