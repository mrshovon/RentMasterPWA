import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { supabaseAdminEngine } from '@/lib/supabase-server';

// =====================================================================================
// 👤 ACCOUNT PROFILE — owner AND super-admin self-service (both are Supabase auth users).
// GET   -> { email, name, phone, role }
// PATCH { name?, phone? } -> merged into user_metadata.
//
// Lives under /api/admin/ so middleware authenticates the caller and injects x-rentmaster-uid;
// the route keys off that alone, exactly like the sibling owner/password and owner/settings
// routes, which is what makes it work for the admin too.
//
// EMAIL IS READ-ONLY. It is returned so the UI can show which account is signed in, and is
// never read from the request body: changing a login address needs a verification flow
// (confirm-new-address / re-auth) that does not exist here, and silently rewriting it with the
// service role would let one bad request lock someone out of their own account.
//
// NOTE: assertOwnerCanWrite is deliberately NOT applied. That guard rejects owners whose
// subscription has lapsed — correct for creating properties, wrong here. Fixing a typo in your
// own name must not be gated behind renewing a plan.
// =====================================================================================

const MAX_NAME_LEN = 120;
const MAX_PHONE_LEN = 30;

export async function GET(request: NextRequest) {
  try {
    const uid = request.headers.get('x-rentmaster-uid');
    if (request.headers.get('x-rentmaster-tenant-id')) {
      return NextResponse.json({ error: 'Tenants have their own profile route.' }, { status: 403 });
    }
    if (!uid) return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 });

    const { data, error } = await supabaseAdminEngine.auth.admin.getUserById(uid);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    const user = data?.user;
    if (!user) return NextResponse.json({ error: 'Account not found.' }, { status: 404 });

    const meta = (user.user_metadata as any) || {};
    return NextResponse.json({
      success: true,
      data: {
        email: user.email ?? null,
        name: meta.name ?? null,
        phone: meta.phone ?? user.phone ?? null,
        role: meta.role || 'owner',
      },
    }, { status: 200 });
  } catch (err: any) {
    console.error('Account profile GET crash:', err);
    return NextResponse.json({ error: err.message || 'Fatal Server Logic Exception.' }, { status: 500 });
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const uid = request.headers.get('x-rentmaster-uid');
    if (request.headers.get('x-rentmaster-tenant-id')) {
      return NextResponse.json({ error: 'Tenants have their own profile route.' }, { status: 403 });
    }
    if (!uid) return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 });

    const body = await request.json();
    const hasName = typeof body.name === 'string';
    const hasPhone = typeof body.phone === 'string';
    if (!hasName && !hasPhone) {
      return NextResponse.json({ error: 'Provide name and/or phone (string).' }, { status: 400 });
    }

    const name = hasName ? String(body.name).trim().slice(0, MAX_NAME_LEN) : undefined;
    const phone = hasPhone ? String(body.phone).trim().slice(0, MAX_PHONE_LEN) : undefined;
    if (hasName && !name) {
      return NextResponse.json({ error: 'Name cannot be empty.' }, { status: 400 });
    }

    // Read-modify-write so the keys this route knows nothing about survive: role (which is what
    // makes the super-admin an admin), signature_url, and both message templates.
    const { data: current, error: readErr } = await supabaseAdminEngine.auth.admin.getUserById(uid);
    if (readErr || !current?.user) {
      return NextResponse.json({ error: readErr?.message || 'Account not found.' }, { status: 404 });
    }
    const meta: Record<string, any> = { ...((current.user.user_metadata as any) || {}) };
    if (name !== undefined) meta.name = name;
    if (phone !== undefined) meta.phone = phone;

    const { data: updated, error: updErr } =
      await supabaseAdminEngine.auth.admin.updateUserById(uid, { user_metadata: meta });
    if (updErr) return NextResponse.json({ error: updErr.message }, { status: 500 });

    return NextResponse.json({
      success: true,
      data: {
        email: updated?.user?.email ?? current.user.email ?? null,
        name: meta.name ?? null,
        phone: meta.phone ?? null,
        role: meta.role || 'owner',
      },
    }, { status: 200 });
  } catch (err: any) {
    console.error('Account profile PATCH crash:', err);
    return NextResponse.json({ error: err.message || 'Fatal Server Logic Exception.' }, { status: 500 });
  }
}
