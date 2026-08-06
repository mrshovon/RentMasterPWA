import { NextResponse } from 'next/server';
import { supabaseAdminEngine } from '@/lib/supabase-server';
import { computeExpiry } from '@/lib/payments/activate';

// =====================================================================================
// 🛡️ ADMIN — SUBSCRIPTION TIERS + PLAN ASSIGNMENT
// GET  -> list available subscription tiers
// POST -> assign/override a plan for an owner (writes an active subscription_history row)
// =====================================================================================
export async function GET() {
  try {
    const { data, error } = await supabaseAdminEngine
      .from('subscription_tiers')
      .select('*')
      .order('price', { ascending: true });
    if (error) throw error;
    return NextResponse.json({ success: true, count: data?.length || 0, data }, { status: 200 });
  } catch (err: any) {
    console.error('Admin Tiers GET error:', err);
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { ownerId, tierId } = body;
    if (!ownerId || !tierId) {
      return NextResponse.json({ success: false, error: 'ownerId and tierId are required.' }, { status: 400 });
    }

    // Tenure follows the assigned tier. `durationDays` is now only an explicit admin
    // override — it used to be the ONLY input, defaulting to 30, with the tier's billing
    // interval ignored entirely, so assigning a yearly plan gave the owner 30 days.
    let expiry: Date | null;
    if (body.durationDays) {
      expiry = new Date();
      expiry.setDate(expiry.getDate() + parseInt(body.durationDays, 10));
    } else {
      const { data: tier } = await supabaseAdminEngine
        .from('subscription_tiers')
        .select('*') // not a column list: duration_days may predate ADD_PLAN_TENURE.sql (42703)
        .eq('id', tierId)
        .maybeSingle();
      expiry = computeExpiry(tier || {});
    }

    const { data, error } = await supabaseAdminEngine
      .from('subscription_history')
      .insert({
        owner_id: ownerId,
        tier_id: tierId,
        gateway_subscription_id: 'ADMIN_ASSIGNED',
        amount_paid: parseFloat(body.amountPaid || '0'),
        status: 'active',
        expiry_date: expiry ? expiry.toISOString() : null,
      })
      .select('*, subscription_tiers:tier_id ( name, price )')
      .single();

    if (error) throw error;
    return NextResponse.json({ success: true, message: 'Plan assigned.', data }, { status: 201 });
  } catch (err: any) {
    console.error('Admin Subscription assign error:', err);
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}
