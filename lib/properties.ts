// =====================================================================================
// Shared property helpers.
//
// generateUniqueUnitId() lived unexported inside app/api/admin/properties/route.ts until the
// building console needed to create a property too — when a building admin gives a flat owner a
// flat, that flat becomes a rentable unit in the owner's own dashboard so they can put a tenant in
// it, bill rent and print receipts. Two copies of an id generator is how two id formats happen.
//
// ⚠️ properties.id is TEXT, not uuid. The base schema was made by hand (see MIGRATIONS.md), and
// these ids are human-facing — "UNIT-4821" is what an owner reads on a screen.
// =====================================================================================

import { supabaseAdminEngine } from './supabase-server';

/**
 * A free UNIT-#### id. Retries on collision, then falls back to a timestamp tail — a duplicate id
 * would be a primary-key error on insert, and a property the owner cannot create is worse than an
 * id that is not pretty.
 */
export async function generateUniqueUnitId(): Promise<string> {
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

/**
 * Create the rentable unit that sits behind one building flat, and return its id.
 *
 * ⚠️ THIS IS THE ONE PROPERTY-CREATION PATH WITH NO checkCreateLimit(). That is correct rather
 * than an oversight: the owner is inside a Whole Building plan, so their resolved limits are
 * unlimited (-1/-1) and a limit check could only ever pass. It is called out because every other
 * caller does check, and the next person to read this will wonder.
 *
 * Returns null on failure rather than throwing. A property is the owner's own data and they can
 * create one themselves from their dashboard; failing the whole add-flat — or worse, rolling back
 * a freshly created auth user — over it would be the wrong trade.
 */
export async function createFlatProperty(opts: {
  ownerId: string;
  ownerPhone: string | null;
  buildingName: string | null;
  buildingAddress: string | null;
  unitLabel: string | null;
}): Promise<string | null> {
  try {
    const id = await generateUniqueUnitId();
    const { error } = await supabaseAdminEngine.from('properties').insert([
      {
        id,
        owner_id: opts.ownerId,
        name: opts.buildingName || 'Building',
        address: opts.buildingAddress || '',
        flat_no: opts.unitLabel || null,
        // Null means "print my account name" — the same default the owner's own create flow uses.
        receipt_name: null,
        owner_phone: opts.ownerPhone || null,
        is_vacant: true,
      },
    ]);
    if (error) return null;
    return id;
  } catch {
    return null;
  }
}
