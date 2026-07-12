import { NextResponse } from 'next/server';
import { supabaseAdminEngine } from '@/lib/supabase-server';

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const expiryDate = new Date();
    expiryDate.setDate(expiryDate.getDate() + parseInt(body.durationDays || '30'));

    const { error: historyError } = await supabaseAdminEngine
      .from('subscription_history')
      .insert({
        owner_id: body.ownerId,
        tier_id: body.tierId,
        gateway_subscription_id: 'MANUAL_SUPER_ADMIN_OVERRIDE',
        amount_paid: parseFloat(body.amountPaid || '0'),
        status: 'active',
        expiry_date: expiryDate.toISOString()
      });

    if (historyError) throw historyError;

    return NextResponse.json({ success: true, msg: "Manual plan override injected successfully." });
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}