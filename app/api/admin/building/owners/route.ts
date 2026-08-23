import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { supabaseAdminEngine } from '@/lib/supabase-server';
import { assertOwnerCanWrite } from '@/lib/subscription';
import { validateEmail, validatePhone, memberOwnerLoginId, flatToken } from '@/lib/validate';
import { sendEmail } from '@/lib/email/brevo';
import { accountCreated } from '@/lib/email/templates';
import { resolveAppBaseUrl } from '@/lib/public-url';
import { apiError } from '@/lib/api-response';
import {
  requireBuildingAdmin,
  forgetBuildingMembership,
  BUILDING_OWNER_SELECT,
  isDuplicateEmailError,
  LOGIN_ID_MAX_SUFFIX,
} from '@/lib/building';

// =====================================================================================
// 🏢 BUILDING ADMIN — THE OWNER ROSTER
// GET  -> every flat owner in this building, enriched with their login details.
// POST -> create a brand-new owner account AND attach it to this building in one step.
//
// The account created here is an ORDINARY owner: role 'owner', the normal owner dashboard,
// every feature they have today. The only difference is the building_owners row, which makes
// resolveOwnerSubscription() bill them through the building instead of their own plan.
// =====================================================================================

/** Roster rows joined to the auth user behind each one. Rosters are small (flats in a
 *  building), so a targeted lookup per owner beats pulling the whole platform user list. */
async function enrichRoster(rows: any[]) {
  const enriched = await Promise.all(
    rows.map(async (row) => {
      let email: string | null = null;
      let name: string | null = null;
      let phone: string | null = null;
      let suspended = false;
      try {
        const { data } = await supabaseAdminEngine.auth.admin.getUserById(String(row.owner_id));
        const u = data?.user;
        const meta = (u?.user_metadata as any) || {};
        email = u?.email || null;
        name = meta.name || null;
        phone = meta.phone || u?.phone || null;
        suspended = !!(u as any)?.banned_until && new Date((u as any).banned_until).getTime() > Date.now();
      } catch {
        /* a deleted login leaves an orphan roster row; it still lists, just without details */
      }
      return { ...row, email, name, phone, suspended };
    })
  );
  return enriched;
}

export async function GET(request: NextRequest) {
  try {
    const gate = await requireBuildingAdmin(request);
    if (!gate.ok) return NextResponse.json(gate.body, { status: gate.status });

    const { data, error } = await supabaseAdminEngine
      .from('building_owners')
      .select(BUILDING_OWNER_SELECT)
      .eq('building_id', gate.building!.id)
      .order('created_at', { ascending: true });
    if (error) throw error;

    const shaped = await enrichRoster(data || []);
    return NextResponse.json({ success: true, count: shaped.length, data: shaped }, { status: 200 });
  } catch (err) {
    return apiError(request, err);
  }
}

export async function POST(request: NextRequest) {
  try {
    const gate = await requireBuildingAdmin(request);
    if (!gate.ok) return NextResponse.json(gate.body, { status: gate.status });

    const guard = await assertOwnerCanWrite(request.headers.get('x-rentmaster-role'), gate.uid!);
    if (!guard.ok) return NextResponse.json(guard.body, { status: guard.status });

    const body = await request.json();

    // WHETHER THIS BUILDING ISSUES IDENTIFIERS, and everything below branches on it.
    //
    // A building whose house number has been set generates its owners' logins from it; one that
    // has not — every building that existed before this shipped — keeps taking a typed email,
    // forever. That is the whole coexistence story, and it is why house_no is nullable.
    const houseNo = gate.building!.house_no || '';
    const generatesLogins = !!houseNo;

    // Same floor as the public signup and the super-admin create route: an account provisioned
    // for someone else must not be the weakest one in the system.
    //
    // The phone is required when it feeds an identifier. On a legacy building it stays optional,
    // exactly as it was, so adding an owner there keeps working unchanged.
    const parsedPhone = validatePhone(body.phone, { required: generatesLogins });
    if (!parsedPhone.ok) return NextResponse.json({ success: false, error: parsedPhone.error }, { status: 400 });
    const password = String(body.password || body.pass || '');
    if (password.length < 8) {
      return NextResponse.json({ success: false, error: 'Password must be at least 8 characters.' }, { status: 400 });
    }
    const name = String(body.name || '').trim();
    if (!name) return NextResponse.json({ success: false, error: 'The owner needs a name.' }, { status: 400 });

    // ONE INPUT, TWO COLUMNS. The admin types the flat once; `unit_label` keeps it as written
    // for statements ("Flat 4B") and `flat_no` keeps the token that went into the login ("4b").
    const unitLabel = String(body.flatNo ?? body.unitLabel ?? '').trim();
    const flatNo = flatToken(unitLabel);

    const parsedEmail = generatesLogins
      ? memberOwnerLoginId(houseNo, unitLabel, parsedPhone.value)
      : validateEmail(body.email, { required: true });
    if (!parsedEmail.ok) return NextResponse.json({ success: false, error: parsedEmail.error }, { status: 400 });

    // Create, resolving a taken identifier by walking the suffix — two co-owners of one flat
    // sharing a phone land on the same address, and so does a flat whose previous owner was
    // detached (their login stays theirs forever). On a legacy building the loop runs once and
    // a duplicate still reports itself, exactly as before.
    let authUser: Awaited<ReturnType<typeof supabaseAdminEngine.auth.admin.createUser>>['data'] | null = null;
    let authError: { message?: string } | null = null;
    let loginId = parsedEmail.value;
    for (let suffix = 1; suffix <= (generatesLogins ? LOGIN_ID_MAX_SUFFIX : 1); suffix++) {
      if (suffix > 1) {
        const retry = memberOwnerLoginId(houseNo, unitLabel, parsedPhone.value, suffix);
        if (!retry.ok) return NextResponse.json({ success: false, error: retry.error }, { status: 400 });
        loginId = retry.value;
      }

      const attempt = await supabaseAdminEngine.auth.admin.createUser({
        email: loginId,
        password,
        email_confirm: true,
        user_metadata: { name, phone: parsedPhone.value, role: 'owner' },
      });

      authError = attempt.error;
      if (!attempt.error && attempt.data?.user) { authUser = attempt.data; break; }
      if (!isDuplicateEmailError(attempt.error)) break;
    }

    if (!authUser?.user) {
      const msg = isDuplicateEmailError(authError)
        ? generatesLogins
          ? `Could not allocate a login for flat ${unitLabel}: ${parsedEmail.value} and every variant up to -${LOGIN_ID_MAX_SUFFIX} is already taken. Use a different mobile number for this owner.`
          : 'That email already has an account. Ask the platform administrator to attach it instead.'
        : authError?.message || 'The account could not be created.';
      return NextResponse.json({ success: false, error: msg }, { status: 400 });
    }

    const ownerId = authUser.user.id;

    // properties.owner_id has a foreign key to user_profiles.id, so an owner with no profile row
    // cannot create a single property. Best-effort: a trigger may already have made it.
    await supabaseAdminEngine.from('user_profiles').upsert(
      { id: ownerId, name, phone: parsedPhone.value, role: 'owner' },
      { onConflict: 'id' }
    );

    const { data: roster, error: rosterErr } = await supabaseAdminEngine
      .from('building_owners')
      .insert({
        building_id: gate.building!.id,
        owner_id: ownerId,
        unit_label: unitLabel || null,
        flat_no: flatNo || null,
        default_service_charge: Number(body.defaultServiceCharge || 0) || 0,
      })
      .select(BUILDING_OWNER_SELECT)
      .single();

    if (rosterErr) {
      // The login exists but is unattached — it would resolve to the Free plan and look like a
      // stray account. Roll it back so the admin can simply try again.
      await supabaseAdminEngine.auth.admin.deleteUser(ownerId).catch(() => {});
      throw rosterErr;
    }

    forgetBuildingMembership(ownerId);

    // A no-op on a building that issues identifiers: sendEmail() refuses that domain outright.
    void sendEmail({
      to: loginId,
      toName: name,
      ...accountCreated({ name, email: loginId, appUrl: resolveAppBaseUrl(request) }),
    });

    // `email` IS the identifier — after a collision it is not the one the admin previewed, and
    // this response is the only place they are shown which one was issued.
    return NextResponse.json(
      { success: true, data: { ...roster, email: loginId, name, phone: parsedPhone.value, suspended: false } },
      { status: 201 }
    );
  } catch (err) {
    return apiError(request, err);
  }
}
