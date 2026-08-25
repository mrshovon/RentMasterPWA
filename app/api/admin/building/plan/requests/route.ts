import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import crypto from 'crypto';
import { supabaseAdminEngine } from '@/lib/supabase-server';
import { apiError } from '@/lib/api-response';
import { requireBuildingAdmin } from '@/lib/building';
import { BUILDING_PLAN_METHODS } from '@/lib/building-plan';
import { sendPushToRole } from '@/lib/push-send';

// =====================================================================================
// 🏢💳 BUILDING ADMIN — RENEWAL REQUESTS AND PAYMENT CLAIMS
// GET  -> this building's own request history.
// POST -> file a renewal request, or claim a payment we have not recorded yet.
//
// Two kinds, one table, one admin queue — see ADD_BUILDING_PLANS.sql. A renewal request starts
// the conversation ("we want another year, plus maintenance"); a payment claim says "we already
// sent the money, here is the transaction id". Neither moves the term on its own: an admin turns
// a renewal into a quote and a claim into a real payment. An unverified claim must never extend
// a contract, which is exactly why this is a request and not a payment row.
//
// ⚠️ NO assertOwnerCanWrite() — see the header of ../route.ts. A locked building is who needs
// this most, and refusing their renewal request because they are locked would be absurd.
// =====================================================================================

const MAX_MESSAGE_LEN = 2000;
const REQUEST_KINDS = ['renewal', 'payment_claim'] as const;

/** Statuses that mean "we are still working on this" — one open request per kind at a time. */
const OPEN_STATUSES = ['new', 'in_progress', 'quoted'];

export async function GET(request: NextRequest) {
  try {
    const gate = await requireBuildingAdmin(request);
    if (!gate.ok) return NextResponse.json(gate.body, { status: gate.status });

    const { data, error } = await supabaseAdminEngine
      .from('building_plan_requests')
      .select('*')
      .eq('building_id', gate.building!.id)
      .order('created_at', { ascending: false });
    if (error) throw error;

    return NextResponse.json({ success: true, count: data?.length || 0, data: data || [] }, { status: 200 });
  } catch (err) {
    return apiError(request, err);
  }
}

export async function POST(request: NextRequest) {
  try {
    const gate = await requireBuildingAdmin(request);
    if (!gate.ok) return NextResponse.json(gate.body, { status: gate.status });

    const body = await request.json();
    const kind = String(body.kind || 'renewal');
    if (!(REQUEST_KINDS as readonly string[]).includes(kind)) {
      return NextResponse.json({ success: false, error: 'Unknown request type.' }, { status: 400 });
    }

    const message = String(body.message ?? '').trim().slice(0, MAX_MESSAGE_LEN) || null;

    let claimAmount: number | null = null;
    let claimMethod: string | null = null;
    let claimReference: string | null = null;

    if (kind === 'payment_claim') {
      const amount = Number(body.amount);
      if (!Number.isFinite(amount) || amount <= 0) {
        return NextResponse.json(
          { success: false, error: 'Enter the amount you paid.' },
          { status: 400 }
        );
      }
      claimAmount = amount;
      claimMethod = (BUILDING_PLAN_METHODS as readonly string[]).includes(body.method)
        ? String(body.method)
        : 'bank';
      claimReference = String(body.reference ?? '').trim().slice(0, 120) || null;
      if (!claimReference) {
        // Without a reference there is nothing for us to reconcile against a bank or bKash
        // statement, and the claim becomes a phone call rather than a queue item.
        return NextResponse.json(
          { success: false, error: 'Enter the transaction id or bank reference so we can confirm it.' },
          { status: 400 }
        );
      }
    } else if (!message) {
      return NextResponse.json(
        { success: false, error: 'Tell us what you need renewed or added.' },
        { status: 400 }
      );
    }

    // One open request per kind. Without this a building that presses "Request renewal" twice
    // gives us two identical queue items to reconcile by hand. Mirrors the ALREADY_PENDING guard
    // on owner payment submissions.
    const { data: open } = await supabaseAdminEngine
      .from('building_plan_requests')
      .select('id')
      .eq('building_id', gate.building!.id)
      .eq('kind', kind)
      .in('status', OPEN_STATUSES)
      .limit(1);
    if (open && open.length) {
      return NextResponse.json(
        {
          success: false,
          error:
            kind === 'renewal'
              ? 'You already have a renewal request with us. We will get back to you on that one.'
              : 'You already have a payment awaiting confirmation. We will confirm it shortly.',
          code: 'ALREADY_PENDING',
        },
        { status: 409 }
      );
    }

    const id = crypto.randomUUID();
    const { data: row, error } = await supabaseAdminEngine
      .from('building_plan_requests')
      .insert([{
        id,
        building_id: gate.building!.id,
        admin_id: gate.uid!,
        kind,
        message,
        claim_amount: claimAmount,
        claim_method: claimMethod,
        claim_reference: claimReference,
      }])
      .select('*')
      .single();
    if (error) throw error;

    // Fire-and-forget: the queue is only useful if someone knows it filled up. The hash deep-links
    // straight to the new Buildings menu, the way '/admin#payments' already does.
    void sendPushToRole('admin', {
      title: kind === 'renewal' ? 'Building renewal request' : 'Building payment claim',
      body:
        kind === 'renewal'
          ? `${gate.building!.name} has requested a renewal.`
          : `${gate.building!.name} says they have paid ৳${claimAmount}.`,
      url: '/admin#buildings',
      tag: `building-request-${id}`,
    });

    return NextResponse.json({ success: true, data: row }, { status: 201 });
  } catch (err) {
    return apiError(request, err);
  }
}
