import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { supabaseAdminEngine } from '../../../../lib/supabase-server';
import { resolveOwnerSubscription, assertOwnerCanWrite, checkCreateLimit } from '../../../../lib/subscription';

// Generates a human-readable unit code like "UNIT-1234", verifying it isn't
// already taken (the properties.id PK is a text column). Falls back to a longer
// timestamp-based code on the rare chance of repeated collisions.
async function generateUniqueUnitId(): Promise<string> {
  for (let attempt = 0; attempt < 6; attempt++) {
    const candidate = `UNIT-${Math.floor(1000 + Math.random() * 9000)}`;
    const { data: clash } = await supabaseAdminEngine
      .from('properties')
      .select('id')
      .eq('id', candidate)
      .maybeSingle();
    if (!clash) return candidate;
  }
  return `UNIT-${Date.now().toString().slice(-6)}`;
}

// =========================================================
// 📥 1. FETCH ALL PROPERTIES FOR SPECIFIC OWNER (GET)
// =========================================================
export async function GET(request: NextRequest) {
  try {
    const ownerId = request.headers.get('x-rentmaster-uid');
    if (!ownerId || ownerId === 'YOUR_ACTUAL_USER_UUID_FROM_DATABASE') {
      return NextResponse.json({ error: 'Context matching identity extraction missing.' }, { status: 400 });
    }

    // Fetch matching data sets ordered by creation sequence matrix map
    const { data: propertiesList, error: fetchError } = await supabaseAdminEngine
      .from('properties')
      .select('*')
      .eq('owner_id', ownerId)
      .order('created_at', { ascending: false });

    if (fetchError) {
      console.error('Supabase Properties Fetch Error:', fetchError);
      return NextResponse.json({ error: fetchError.message }, { status: 500 });
    }

    return NextResponse.json({ success: true, count: propertiesList.length, data: propertiesList }, { status: 200 });

  } catch (runtimeExceptionCatch: any) {
    console.error('Pipeline Execution Properties GET Critical Route Crash:', runtimeExceptionCatch);
    return NextResponse.json({ error: runtimeExceptionCatch.message || 'Fatal Server Logic Matrix Exception.' }, { status: 500 });
  }
}

// =========================================================
// 📤 2. EXISTING POST HANDLER (KEEPING INTRACTABLE WORKFLOW)
// =========================================================
export async function POST(request: NextRequest) {
  try {
    const ownerId = request.headers.get('x-rentmaster-uid');
    const ownerPhone = request.headers.get('x-rentmaster-phone');

    if (!ownerId || ownerId === 'YOUR_ACTUAL_USER_UUID_FROM_DATABASE') {
      return NextResponse.json({ error: 'Context matching identity missing.' }, { status: 400 });
    }

    const role = request.headers.get('x-rentmaster-role');

    const bodyPayload = await request.json();
    const { name, address, flatNo } = bodyPayload;

    if (!name || !address || !flatNo) {
      return NextResponse.json({ error: 'Validation missing compulsory payload blocks.' }, { status: 400 });
    }

    // Subscription gate: block if the owner's plan is locked, then enforce the tier limit.
    const guard = await assertOwnerCanWrite(role, ownerId);
    if (!guard.ok) return NextResponse.json(guard.body, { status: guard.status });

    if (role === 'owner') {
      const sub = await resolveOwnerSubscription(ownerId);
      const limitCheck = await checkCreateLimit('property', ownerId, sub);
      if (!limitCheck.allowed) {
        return NextResponse.json({
          error: `You've reached your ${sub.tierName} limit of ${limitCheck.limit} propert${limitCheck.limit === 1 ? 'y' : 'ies'}. Upgrade your plan to add more.`,
          code: 'LIMIT_REACHED',
          current: limitCheck.current,
          limit: limitCheck.limit,
        }, { status: 403 });
      }
    }

    const { data: databaseWriteResponse, error: schemaWriteError } = await supabaseAdminEngine
      .from('properties')
      .insert([
        {
          id: await generateUniqueUnitId(),
          owner_id: ownerId,
          name: name,
          address: address,
          flat_no: flatNo,
          owner_phone: ownerPhone,
          is_vacant: true
        }
      ])
      .select()
      .single();

    if (schemaWriteError) {
      console.error('Supabase Core Schema Write Error:', schemaWriteError);
      return NextResponse.json({ error: schemaWriteError.message }, { status: 500 });
    }

    return NextResponse.json({ success: true, data: databaseWriteResponse }, { status: 201 });

  } catch (runtimeExceptionCatch: any) {
    console.error('Pipeline Execution Critical Route Crash Error:', runtimeExceptionCatch);
    return NextResponse.json({ error: runtimeExceptionCatch.message || 'Fatal Server Matrix Logic Crash.' }, { status: 500 });
  }
}