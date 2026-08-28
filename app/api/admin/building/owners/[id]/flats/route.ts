import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { supabaseAdminEngine } from '@/lib/supabase-server';
import { assertOwnerCanWrite } from '@/lib/subscription';
import { apiError } from '@/lib/api-response';
import { flatToken } from '@/lib/validate';
import { requireBuildingAdmin, ownerInBuilding, flatsOfOwner } from '@/lib/building';
import { readFlatsFromBody, insertOwnerFlats } from '@/lib/building-flats';

// =====================================================================================
// 🏢 BUILDING ADMIN — ONE OWNER'S FLATS
// GET  -> every flat this owner holds, active and inactive.
// POST -> add one or more flats, each with the rentable unit behind it.
//
// WHY THIS IS ITS OWN RESOURCE rather than a `flats` array on the owner PATCH: an array on a PATCH
// has to be DIFFED against what is stored, and a diff is how a flat with a year of invoices behind
// it gets deleted because it was missing from a payload someone built by hand. Adding a flat and
// removing a flat are different decisions with different consequences, so they are different calls.
//
// THE LOGIN IS NEVER TOUCHED HERE. It is auth.users.email, built once from the owner's FIRST flat
// and frozen — see owners/[id]/route.ts. Adding a fourth flat, or removing the one the identifier
// was built from, changes nothing about how the person signs in. building_owners.unit_label and
// .flat_no are that flat's provenance and are only re-pointed when the PRIMARY flat changes.
// =====================================================================================

export async function GET(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const gate = await requireBuildingAdmin(request);
    if (!gate.ok) return NextResponse.json(gate.body, { status: gate.status });

    const { id } = await ctx.params;
    if (!(await ownerInBuilding(gate.building!.id, id))) {
      return NextResponse.json({ success: false, error: 'That owner is not on this building.' }, { status: 404 });
    }

    const flats = await flatsOfOwner(id, false);
    return NextResponse.json({ success: true, count: flats.length, data: flats }, { status: 200 });
  } catch (err) {
    return apiError(request, err);
  }
}

export async function POST(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const gate = await requireBuildingAdmin(request);
    if (!gate.ok) return NextResponse.json(gate.body, { status: gate.status });

    const guard = await assertOwnerCanWrite(request.headers.get('x-rentmaster-role'), gate.uid!);
    if (!guard.ok) return NextResponse.json(guard.body, { status: guard.status });

    const { id } = await ctx.params;
    if (!(await ownerInBuilding(gate.building!.id, id))) {
      return NextResponse.json({ success: false, error: 'That owner is not on this building.' }, { status: 404 });
    }

    const body = await request.json();

    // No flat here feeds a login, so a label is required on every one of them — including the
    // first. `requireFlat` only exists for the legacy typed-email building at creation time.
    let flats;
    try {
      flats = readFlatsFromBody(body, { requireFlat: true });
    } catch (e: any) {
      return NextResponse.json({ success: false, error: e.message }, { status: 400 });
    }

    // Compare on the normalised token, not the typed label: "3B", "3b" and "Flat 3B" are the same
    // flat, and flatToken() is the same normaliser the login identifier was built with.
    const existing = await flatsOfOwner(id, false);
    const taken = new Set(
      existing.filter((f) => f.is_active).map((f) => f.flat_no || flatToken(f.unit_label || '')).filter(Boolean),
    );
    const clash = flats.find((f) => taken.has(flatToken(f.unitLabel)));
    if (clash) {
      return NextResponse.json(
        { success: false, error: `${clash.unitLabel} is already on this owner's list.` },
        { status: 409 },
      );
    }

    const created = await insertOwnerFlats({
      buildingId: gate.building!.id,
      ownerId: id,
      ownerPhone: null,
      building: gate.building!,
      flats,
      // Only when they have none — an owner who already holds flats keeps the primary they have,
      // because it is the provenance of a login that must not appear to move.
      firstIsPrimary: existing.length === 0,
    });

    return NextResponse.json(
      {
        success: true,
        data: created.flats,
        message: created.flats.length === 1 ? 'Flat added.' : `${created.flats.length} flats added.`,
        warnings: created.warnings.length ? created.warnings : undefined,
      },
      { status: 201 },
    );
  } catch (err) {
    return apiError(request, err);
  }
}
