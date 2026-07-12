import { NextResponse } from 'next/server';
import { supabaseAdminEngine } from '@/lib/supabase-server';

// =====================================================================================
// 🛡️ ADMIN — OWNERS DIRECTORY
// GET  -> list all owner/admin accounts (auth users) + their latest subscription
// POST -> create a new owner account
// =====================================================================================
export async function GET() {
  try {
    const { data: list, error } = await supabaseAdminEngine.auth.admin.listUsers({ page: 1, perPage: 1000 });
    if (error) throw error;

    // Latest subscription per owner.
    const { data: subs } = await supabaseAdminEngine
      .from('subscription_history')
      .select('owner_id, tier_id, status, expiry_date, created_at')
      .order('created_at', { ascending: false });
    const latestSub: Record<string, any> = {};
    for (const s of subs || []) if (!latestSub[s.owner_id]) latestSub[s.owner_id] = s;

    const owners = (list?.users || []).map((u) => {
      const meta = (u.user_metadata as any) || {};
      const banned = !!(u as any).banned_until && new Date((u as any).banned_until).getTime() > Date.now();
      return {
        id: u.id,
        email: u.email || null,
        name: meta.name || null,
        phone: meta.phone || u.phone || null,
        role: meta.role || 'owner',
        created_at: u.created_at,
        last_sign_in_at: u.last_sign_in_at || null,
        suspended: banned,
        permissions_revoked: !!meta.permissions_revoked,
        subscription: latestSub[u.id] || null,
      };
    });

    return NextResponse.json({ success: true, count: owners.length, data: owners }, { status: 200 });
  } catch (err: any) {
    console.error('Admin Owners GET error:', err);
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    if (!body.email || !body.pass) {
      return NextResponse.json({ success: false, error: 'email and pass are required.' }, { status: 400 });
    }

    const { data: authUser, error: authError } = await supabaseAdminEngine.auth.admin.createUser({
      email: body.email,
      password: body.pass,
      email_confirm: true,
      user_metadata: {
        name: body.name,
        phone: body.phone,
        role: body.role || 'owner',
      },
    });

    if (authError || !authUser.user) throw authError;

    // Mirror into user_profiles (best-effort; ignore if a trigger already handles it).
    await supabaseAdminEngine.from('user_profiles').upsert({
      id: authUser.user.id,
      name: body.name || 'Owner',
      phone: body.phone || '',
      role: body.role || 'owner',
    }, { onConflict: 'id' });

    return NextResponse.json({ success: true, ownerId: authUser.user.id }, { status: 201 });
  } catch (err: any) {
    console.error('Admin Owners POST error:', err);
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}
