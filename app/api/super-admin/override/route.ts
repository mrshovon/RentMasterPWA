import { NextResponse } from 'next/server';
import { supabaseAdminEngine } from '@/lib/supabase-server';
import { computeExpiry } from '@/lib/payments/activate';
import { apiError } from '@/lib/api-response';

export async function POST(request: Request) {
  try {
    const body = await request.json();

    // Tenure follows the tier unless the admin explicitly passes durationDays. This used to
    // ALWAYS be `+ durationDays (default 30)` with no reference to the tier at all, so a
    // manually-injected yearly plan quietly expired in a month.
    let expiryDate: Date | null;
    if (body.durationDays) {
      expiryDate = new Date();
      expiryDate.setDate(expiryDate.getDate() + parseInt(body.durationDays, 10));
    } else {
      const { data: tier } = await supabaseAdminEngine
        .from('subscription_tiers')
        .select('*') // not a column list: duration_days may predate ADD_PLAN_TENURE.sql (42703)
        .eq('id', body.tierId)
        .maybeSingle();
      expiryDate = computeExpiry(tier || {});
    }

    const { error: historyError } = await supabaseAdminEngine
      .from('subscription_history')
      .insert({
        owner_id: body.ownerId,
        tier_id: body.tierId,
        gateway_subscription_id: 'MANUAL_SUPER_ADMIN_OVERRIDE',
        amount_paid: parseFloat(body.amountPaid || '0'),
        status: 'active',
        expiry_date: expiryDate ? expiryDate.toISOString() : null,
      });

    if (historyError) throw historyError;

    return NextResponse.json({ success: true, msg: "Manual plan override injected successfully." });
  } catch (err) {
    return apiError(request, err);
  }
}