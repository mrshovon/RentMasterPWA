import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { supabaseAdminEngine } from '@/lib/supabase-server';

// =====================================================================================
// 🛡️ ADMIN — SINGLE TIER: edit fields / activate|deactivate / set discount / delete
// =====================================================================================
export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const b = await request.json();

    const updates: Record<string, any> = {};
    if (b.name !== undefined) updates.name = b.name;
    if (b.description !== undefined) updates.description = b.description || null;
    if (b.price !== undefined) updates.price = parseFloat(b.price);
    if (b.currency !== undefined) updates.currency = b.currency;
    if (b.billing_interval !== undefined) updates.billing_interval = b.billing_interval;
    if (b.maxProperties !== undefined) updates.max_properties_allowed = parseInt(b.maxProperties, 10);
    if (b.maxTenants !== undefined) updates.max_tenants_allowed = parseInt(b.maxTenants, 10);
    if (b.discountPercent !== undefined) updates.discount_percent = parseFloat(b.discountPercent);
    if (b.isActive !== undefined) updates.is_active = !!b.isActive;
    if (b.action === 'activate') updates.is_active = true;
    if (b.action === 'deactivate') updates.is_active = false;

    if (Object.keys(updates).length === 0) {
      return NextResponse.json({ success: false, error: 'No fields to update.' }, { status: 400 });
    }

    const { data, error } = await supabaseAdminEngine
      .from('subscription_tiers').update(updates).eq('id', id).select().single();
    if (error) throw error;
    return NextResponse.json({ success: true, data }, { status: 200 });
  } catch (err: any) {
    console.error('Admin Tier PATCH error:', err);
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}

export async function DELETE(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const { error } = await supabaseAdminEngine.from('subscription_tiers').delete().eq('id', id);
    if (error) {
      // Likely referenced by subscription_history — advise deactivating instead.
      return NextResponse.json({ success: false, error: `${error.message} (tip: deactivate the plan instead of deleting it).` }, { status: 409 });
    }
    return NextResponse.json({ success: true, message: 'Tier deleted.' }, { status: 200 });
  } catch (err: any) {
    console.error('Admin Tier DELETE error:', err);
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}
