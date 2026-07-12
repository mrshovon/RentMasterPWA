import { NextResponse } from 'next/server';
import { supabaseAdminEngine } from '@/lib/supabase-server';

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

    const expiry = new Date();
    expiry.setDate(expiry.getDate() + parseInt(body.durationDays || '30', 10));

    const { data, error } = await supabaseAdminEngine
      .from('subscription_history')
      .insert({
        owner_id: ownerId,
        tier_id: tierId,
        gateway_subscription_id: 'ADMIN_ASSIGNED',
        amount_paid: parseFloat(body.amountPaid || '0'),
        status: 'active',
        expiry_date: expiry.toISOString(),
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
