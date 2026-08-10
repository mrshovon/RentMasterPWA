import { NextResponse } from 'next/server';
import { supabaseAdminEngine } from '@/lib/supabase-server';
import { validateEmail, validatePhone } from '@/lib/validate';
import { getPresenceFor } from '@/lib/presence';
import { apiError } from '@/lib/api-response';
import { sendEmail } from '@/lib/email/brevo';
import { accountCreated } from '@/lib/email/templates';
import { resolveAppBaseUrl } from '@/lib/public-url';

// =====================================================================================
// 🛡️ ADMIN — OWNERS DIRECTORY
// GET  -> list all owner/admin accounts (auth users) + their latest subscription
// POST -> create a new owner account
// =====================================================================================
export async function GET(request: Request) {
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

    // Live presence for the whole directory in one query (see lib/presence.ts). Degrades to
    // an empty map — every account simply reads as "never seen" — if ADD_PRESENCE.sql has
    // not been run yet, rather than taking the owners list down.
    const presence = await getPresenceFor((list?.users || []).map((u) => u.id));

    const owners = (list?.users || []).map((u) => {
      const meta = (u.user_metadata as any) || {};
      const banned = !!(u as any).banned_until && new Date((u as any).banned_until).getTime() > Date.now();
      const seen = presence[u.id];
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
        // Presence: heartbeat-derived, so it means "app open now", not "logged in at some point".
        online: !!seen?.online,
        last_seen_at: seen?.lastSeenAt || null,
      };
    });

    return NextResponse.json({ success: true, count: owners.length, data: owners }, { status: 200 });
  } catch (err) {
    return apiError(request, err);
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json();

    // This route used to accept any non-empty email and ANY password — no format check, no
    // length floor — so accounts provisioned by an admin were the weakest in the system, weaker
    // than what the public signup form allows. Same rules as /api/auth/signup now.
    const parsedEmail = validateEmail(body.email, { required: true });
    if (!parsedEmail.ok) {
      return NextResponse.json({ success: false, error: parsedEmail.error }, { status: 400 });
    }
    const parsedPhone = validatePhone(body.phone);
    if (!parsedPhone.ok) {
      return NextResponse.json({ success: false, error: parsedPhone.error }, { status: 400 });
    }
    const password = String(body.pass || '');
    if (password.length < 8) {
      return NextResponse.json({ success: false, error: 'Password must be at least 8 characters.' }, { status: 400 });
    }

    const { data: authUser, error: authError } = await supabaseAdminEngine.auth.admin.createUser({
      email: parsedEmail.value,
      password,
      email_confirm: true,
      user_metadata: {
        name: body.name,
        phone: parsedPhone.value,
        role: body.role || 'owner',
      },
    });

    if (authError || !authUser.user) throw authError;

    // Mirror into user_profiles (best-effort; ignore if a trigger already handles it).
    await supabaseAdminEngine.from('user_profiles').upsert({
      id: authUser.user.id,
      name: body.name || 'Owner',
      phone: parsedPhone.value,
      role: body.role || 'owner',
    }, { onConflict: 'id' });

    // Welcome mail, fire-and-forget. Deliberately does NOT contain the password the admin just
    // set — that goes out-of-band, the way it always has. This only tells the person an account
    // exists and where to sign in, which they otherwise learn only if the admin remembers to say.
    void sendEmail({
      to: parsedEmail.value,
      toName: body.name || null,
      ...accountCreated({
        name: body.name || '',
        email: parsedEmail.value,
        appUrl: resolveAppBaseUrl(request),
      }),
    });

    return NextResponse.json({ success: true, ownerId: authUser.user.id }, { status: 201 });
  } catch (err) {
    return apiError(request, err);
  }
}
