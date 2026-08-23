import { NextResponse } from 'next/server';
import { supabaseAdminEngine } from '@/lib/supabase-server';
import { validateEmail, validatePhone, buildingAdminLoginId } from '@/lib/validate';
import { getPresenceFor } from '@/lib/presence';
import { apiError } from '@/lib/api-response';
import { sendEmail } from '@/lib/email/brevo';
import { accountCreated } from '@/lib/email/templates';
import { resolveAppBaseUrl } from '@/lib/public-url';
import { activateSubscription } from '@/lib/payments/activate';
import { WHOLE_BUILDING_TIER_ID, isDuplicateEmailError, LOGIN_ID_MAX_SUFFIX } from '@/lib/building';

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

    // THE ROLE SPLIT. `authRole` is what ends up in user_metadata and is the role the whole app
    // reads. `profileRole` is what goes into user_profiles.role — a Postgres ENUM with only
    // 'owner' and 'tenant' in it.
    //
    // A trigger on auth.users mirrors user_metadata.role into that enum on INSERT, so passing
    // anything else to createUser() fails outright with an opaque "Database error creating new
    // user". Both elevated roles are therefore created as 'owner' and PROMOTED immediately
    // afterwards with updateUserById, which the trigger does not fire on. Keeping the profile row
    // at 'owner' is also load-bearing: properties.owner_id has a foreign key to user_profiles.id,
    // so an elevated account still needs a valid 'owner' row to hold properties of its own.
    //
    // Resolved FIRST, because it now decides how the account is identified as well.
    const ELEVATED_ROLES = ['admin', 'building_admin'];
    const requestedRole = String(body.role || 'owner');
    const authRole = ELEVATED_ROLES.includes(requestedRole) ? requestedRole : 'owner';
    const profileRole = 'owner';
    const isBuildingAdmin = authRole === 'building_admin';

    // This route used to accept any non-empty email and ANY password — no format check, no
    // length floor — so accounts provisioned by an admin were the weakest in the system, weaker
    // than what the public signup form allows. Same rules as /api/auth/signup now.
    //
    // The phone is required ONLY for a building admin, whose identifier is derived from it.
    // Plain owners and platform admins created here keep the optional phone they always had —
    // widening that would start rejecting account creations that work today.
    const parsedPhone = validatePhone(body.phone, { required: isBuildingAdmin });
    if (!parsedPhone.ok) {
      return NextResponse.json({ success: false, error: parsedPhone.error }, { status: 400 });
    }
    const password = String(body.pass || '');
    if (password.length < 8) {
      return NextResponse.json({ success: false, error: 'Password must be at least 8 characters.' }, { status: 400 });
    }

    const buildingName = String(body.buildingName || '').trim().slice(0, 200);
    const buildingHouseNo = String(body.buildingHouseNo || '').trim().slice(0, 40);
    if (isBuildingAdmin && !buildingName) {
      return NextResponse.json(
        { success: false, error: 'A building admin needs a building name.' },
        { status: 400 }
      );
    }

    // TWO WAYS TO BE IDENTIFIED, and the role picks one.
    //
    // A building admin does not shop for this app — they are set up by whoever sells them the
    // plan, so they get a generated identifier built from their house number and mobile and
    // never type an address at all. Everyone else created here still supplies a real one.
    //
    // `body.email` is ignored outright on the building branch rather than used as a fallback:
    // accepting a typed address for an account that is supposed to have a derived one is how
    // the two schemes would quietly drift back into one.
    let parsedEmail;
    if (isBuildingAdmin) {
      parsedEmail = buildingAdminLoginId(buildingHouseNo, parsedPhone.value);
    } else {
      parsedEmail = validateEmail(body.email, { required: true });
    }
    if (!parsedEmail.ok) {
      return NextResponse.json({ success: false, error: parsedEmail.error }, { status: 400 });
    }

    // Create, resolving a taken identifier by walking the suffix. Only the generated branch can
    // collide meaningfully — a typed address that is already registered must still report that,
    // so the loop runs once for it and falls through to the throw.
    let authUser: Awaited<ReturnType<typeof supabaseAdminEngine.auth.admin.createUser>>['data'] | null = null;
    let loginId = parsedEmail.value;
    for (let suffix = 1; suffix <= (isBuildingAdmin ? LOGIN_ID_MAX_SUFFIX : 1); suffix++) {
      if (suffix > 1) {
        const retry = buildingAdminLoginId(buildingHouseNo, parsedPhone.value, suffix);
        if (!retry.ok) return NextResponse.json({ success: false, error: retry.error }, { status: 400 });
        loginId = retry.value;
      }

      const attempt = await supabaseAdminEngine.auth.admin.createUser({
        email: loginId,
        password,
        email_confirm: true,
        user_metadata: {
          name: body.name,
          phone: parsedPhone.value,
          role: profileRole,
        },
      });

      if (!attempt.error && attempt.data.user) { authUser = attempt.data; break; }
      if (!isDuplicateEmailError(attempt.error)) throw attempt.error;
    }

    if (!authUser?.user) {
      // Every variant taken. A 400 rather than a 500: nothing is broken, the admin just has to
      // free one up or use a different number, and only they can decide which.
      return NextResponse.json(
        {
          success: false,
          error: `Could not allocate a login for house ${buildingHouseNo}: ${parsedEmail.value} and every variant up to -${LOGIN_ID_MAX_SUFFIX} is already taken. Delete the stale account holding one, or use a different mobile number for this admin.`,
        },
        { status: 400 }
      );
    }

    // Promote. Metadata is SPREAD, not replaced — updateUserById overwrites the whole object, so
    // naming only `role` here would silently wipe the name and phone set a moment ago.
    if (authRole !== profileRole) {
      const { error: promoteErr } = await supabaseAdminEngine.auth.admin.updateUserById(authUser.user.id, {
        user_metadata: { ...(authUser.user.user_metadata || {}), role: authRole },
      });
      if (promoteErr) throw promoteErr;
    }

    // Mirror into user_profiles (best-effort; ignore if a trigger already handles it).
    await supabaseAdminEngine.from('user_profiles').upsert({
      id: authUser.user.id,
      name: body.name || 'Owner',
      phone: parsedPhone.value,
      role: profileRole,
    }, { onConflict: 'id' });

    // A building admin is nothing without a building and a plan. Both are best-effort so a
    // half-configured tier can never 500 the account creation — the admin gets the login plus a
    // warning telling them exactly what to finish by hand.
    const warnings: string[] = [];
    if (authRole === 'building_admin') {
      const { error: buildingErr } = await supabaseAdminEngine.from('buildings').insert({
        id: crypto.randomUUID(),
        admin_id: authUser.user.id,
        name: buildingName,
        // Stored as the admin wrote it ("12/A"). The identifier's own normalisation happens in
        // lib/validate.ts, so this stays readable on a printed statement.
        house_no: buildingHouseNo || null,
        address: String(body.buildingAddress || '').trim() || null,
        city: String(body.buildingCity || '').trim() || null,
      });
      if (buildingErr) {
        warnings.push(`The building record could not be created (${buildingErr.message}). Has ADD_BUILDINGS.sql been run?`);
      }

      // Without this row they resolve to the Free baseline and silently cap at 2 properties /
      // 2 tenants, because a building admin is plan-governed exactly like an owner.
      try {
        await activateSubscription({
          ownerId: authUser.user.id,
          tierId: WHOLE_BUILDING_TIER_ID,
          amountPaid: 0,
          ref: 'ADMIN_ASSIGNED',
        });
      } catch (planErr: any) {
        warnings.push(
          `The Whole Building plan could not be assigned (${planErr?.message || planErr}). Assign it from the Plans tab, or they will be capped at the free limits.`
        );
      }
    }

    // Welcome mail, fire-and-forget. Deliberately does NOT contain the password the admin just
    // set — that goes out-of-band, the way it always has. This only tells the person an account
    // exists and where to sign in, which they otherwise learn only if the admin remembers to say.
    //
    // A no-op for a building admin: sendEmail() refuses the system-login domain outright.
    void sendEmail({
      to: loginId,
      toName: body.name || null,
      ...accountCreated({
        name: body.name || '',
        email: loginId,
        appUrl: resolveAppBaseUrl(request),
      }),
    });

    return NextResponse.json(
      {
        success: true,
        ownerId: authUser.user.id,
        role: authRole,
        // The address that was actually issued, which after a collision is NOT the one the
        // admin previewed. It is also the only copy of it they will ever be handed.
        loginId,
        warnings: warnings.length ? warnings : undefined,
      },
      { status: 201 }
    );
  } catch (err) {
    return apiError(request, err);
  }
}
