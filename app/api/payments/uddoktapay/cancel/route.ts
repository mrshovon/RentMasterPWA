import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { supabaseAdminEngine } from '@/lib/supabase-server';
import { apiError } from '@/lib/api-response';
import { verifyCancelSignature } from '@/lib/payments/cancel-token';

// =====================================================================================
// UDDOKTAPAY CANCEL — PUBLIC, SIGNED
// POST { ref, sig } -> retire the submission named by `ref`, if `sig` proves the link is ours.
//
// Sits under /api/payments/ rather than /api/admin/ for the same reason the webhook does:
// middleware requires a bearer token on /api/admin/*, and the caller here has none. On Android the
// gateway runs in Chrome, whose localStorage holds no session at all, so an authenticated cancel
// route is unreachable from the one place it is most needed. See lib/payments/cancel-token.ts.
//
// The authenticated twin at /api/admin/payments/uddoktapay/cancel stays: payments created before
// this shipped carry an unsigned cancel_url, and that route is how those still get cancelled.
//
// ⭐ THE SIGNATURE IS NOT WHAT KEEPS THE MONEY SAFE — the WHERE clause is.
// `gateway_invoice_id is null` means no gateway invoice was ever bound to this row, i.e. no money
// was attached. It is in the UPDATE rather than in a prior read so that fulfilment landing in the
// gap makes this match zero rows instead of voiding a real payment. The signature is what stops
// one owner cancelling ANOTHER owner's attempt, which a bare uuid in a URL would not.
// =====================================================================================

export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));
    const ref = String(body?.ref || '').trim();
    const sig = String(body?.sig || '').trim();

    if (!ref || !sig || !verifyCancelSignature(ref, sig)) {
      // One answer for a missing reference, a bad signature and an unknown id alike. Telling them
      // apart would turn this into an oracle for which submission ids exist.
      return NextResponse.json(
        { success: false, error: 'This cancellation link is not valid.' },
        { status: 400 },
      );
    }

    const { data, error } = await supabaseAdminEngine
      .from('payment_submissions')
      .update({
        status: 'cancelled',
        admin_notes: 'Cancelled by the owner before payment.',
        updated_at: new Date().toISOString(),
      })
      .eq('id', ref)
      .eq('provider', 'uddoktapay')
      .eq('status', 'pending')
      .is('gateway_invoice_id', null)
      .select('id');
    if (error) return apiError(request, error);

    if ((data || []).length > 0) {
      return NextResponse.json({ success: true, data: { outcome: 'cancelled' as const } }, { status: 200 });
    }

    // Nothing matched. Either it was already dealt with, or the payment actually COMPLETED and
    // fulfilment claimed the row first — the webhook races this page by design. Saying "cancelled"
    // in the second case would tell someone their money had been refused.
    const { data: row } = await supabaseAdminEngine
      .from('payment_submissions')
      .select('status')
      .eq('id', ref)
      .maybeSingle();

    return NextResponse.json(
      {
        success: true,
        data: { outcome: row?.status === 'approved' ? ('completed' as const) : ('nothing_to_cancel' as const) },
      },
      { status: 200 },
    );
  } catch (err) {
    return apiError(request, err);
  }
}
