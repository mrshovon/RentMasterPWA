import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { supabaseAdminEngine } from '@/lib/supabase-server';

// =====================================================================================
// 🛡️ ADMIN — SINGLE OWNER
// GET    -> full details (auth + profile + subscription + property/tenant counts)
// PATCH  -> edit details / reset password / suspend|reactivate / revoke|grant permission
//           / cancel subscription
// DELETE -> remove the account
// =====================================================================================
export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const { data: authRes, error } = await supabaseAdminEngine.auth.admin.getUserById(id);
    if (error || !authRes?.user) {
      return NextResponse.json({ success: false, error: error?.message || 'Owner not found.' }, { status: 404 });
    }
    const u = authRes.user;
    const meta = (u.user_metadata as any) || {};

    const { data: profile } = await supabaseAdminEngine.from('user_profiles').select('*').eq('id', id).maybeSingle();
    const { data: subscription } = await supabaseAdminEngine
      .from('subscription_history')
      .select('*, subscription_tiers:tier_id ( name, price, currency, max_properties_allowed, max_tenants_allowed )')
      .eq('owner_id', id)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    const { data: props } = await supabaseAdminEngine.from('properties').select('id').eq('owner_id', id);
    const propertyIds = (props || []).map((p) => p.id);
    let tenantCount = 0;
    if (propertyIds.length) {
      const { count } = await supabaseAdminEngine
        .from('tenants').select('id', { count: 'exact', head: true }).in('property_id', propertyIds);
      tenantCount = count || 0;
    }

    const banned = !!(u as any).banned_until && new Date((u as any).banned_until).getTime() > Date.now();

    return NextResponse.json({
      success: true,
      data: {
        id: u.id,
        email: u.email || null,
        name: meta.name || null,
        phone: meta.phone || u.phone || null,
        role: meta.role || 'owner',
        created_at: u.created_at,
        last_sign_in_at: u.last_sign_in_at || null,
        suspended: banned,
        permissions_revoked: !!meta.permissions_revoked,
        profile: profile || null,
        subscription: subscription || null,
        propertyCount: propertyIds.length,
        tenantCount,
      },
    }, { status: 200 });
  } catch (err: any) {
    console.error('Admin Owner GET error:', err);
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const body = await request.json();
    const { action, name, phone, password } = body;

    const { data: cur } = await supabaseAdminEngine.auth.admin.getUserById(id);
    const meta = ((cur?.user?.user_metadata as any) || {});

    // --- Account actions ---
    if (action === 'suspend' || action === 'reactivate') {
      const { error } = await supabaseAdminEngine.auth.admin.updateUserById(id, {
        ban_duration: action === 'suspend' ? '876000h' : 'none', // ~100 years / lifted
      });
      if (error) throw error;
      return NextResponse.json({ success: true, message: action === 'suspend' ? 'Account access suspended.' : 'Account access restored.' });
    }

    if (action === 'revoke_permission' || action === 'grant_permission') {
      const { error } = await supabaseAdminEngine.auth.admin.updateUserById(id, {
        user_metadata: { ...meta, permissions_revoked: action === 'revoke_permission' },
      });
      if (error) throw error;
      return NextResponse.json({ success: true, message: action === 'revoke_permission' ? 'Management permissions revoked.' : 'Management permissions restored.' });
    }

    if (action === 'cancel_subscription') {
      const { data: latest } = await supabaseAdminEngine
        .from('subscription_history').select('id').eq('owner_id', id)
        .order('created_at', { ascending: false }).limit(1).maybeSingle();
      if (latest?.id) {
        await supabaseAdminEngine.from('subscription_history')
          .update({ status: 'canceled', canceled_at: new Date().toISOString() }).eq('id', latest.id);
      }
      return NextResponse.json({ success: true, message: 'Subscription canceled.' });
    }

    // --- Reset password ---
    if (password) {
      const { error } = await supabaseAdminEngine.auth.admin.updateUserById(id, { password });
      if (error) throw error;
      return NextResponse.json({ success: true, message: 'Password reset successfully.' });
    }

    // --- Edit details ---
    const nextMeta = { ...meta };
    if (name !== undefined) nextMeta.name = name;
    if (phone !== undefined) nextMeta.phone = phone;
    const { error } = await supabaseAdminEngine.auth.admin.updateUserById(id, { user_metadata: nextMeta });
    if (error) throw error;
    await supabaseAdminEngine.from('user_profiles').update({
      ...(name !== undefined ? { name } : {}),
      ...(phone !== undefined ? { phone } : {}),
    }).eq('id', id);

    return NextResponse.json({ success: true, message: 'Owner details updated.' });
  } catch (err: any) {
    console.error('Admin Owner PATCH error:', err);
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}

export async function DELETE(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const { error } = await supabaseAdminEngine.auth.admin.deleteUser(id);
    if (error) throw error;
    await supabaseAdminEngine.from('user_profiles').delete().eq('id', id);
    return NextResponse.json({ success: true, message: 'Owner account deleted.' });
  } catch (err: any) {
    console.error('Admin Owner DELETE error:', err);
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}
