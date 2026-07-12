import { NextResponse } from 'next/server';
import { supabaseAdminEngine } from '@/lib/supabase-server';

// =====================================================================================
// 🛡️ ADMIN — SUBSCRIPTION TIER MANAGEMENT
// GET  -> all tiers (active + inactive) for the admin console
// POST -> create a new tier
// Requires the tiers migration: is_active boolean, discount_percent numeric.
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
    const b = await request.json();
    if (!b.id || !b.name || b.price === undefined) {
      return NextResponse.json({ success: false, error: 'id, name and price are required.' }, { status: 400 });
    }
    const row = {
      id: String(b.id).trim().toLowerCase().replace(/[^a-z0-9_]/g, '_'),
      name: b.name,
      description: b.description || null,
      price: parseFloat(b.price),
      currency: b.currency || 'BDT',
      billing_interval: b.billing_interval || 'month',
      max_properties_allowed: parseInt(b.maxProperties ?? -1, 10),
      max_tenants_allowed: parseInt(b.maxTenants ?? -1, 10),
      is_active: b.isActive === undefined ? true : !!b.isActive,
      discount_percent: b.discountPercent !== undefined ? parseFloat(b.discountPercent) : 0,
    };
    const { data, error } = await supabaseAdminEngine.from('subscription_tiers').insert(row).select().single();
    if (error) throw error;
    return NextResponse.json({ success: true, data }, { status: 201 });
  } catch (err: any) {
    console.error('Admin Tiers POST error:', err);
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}
