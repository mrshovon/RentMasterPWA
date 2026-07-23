import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { supabaseAdminEngine } from '@/lib/supabase-server';
import { assertOwnerCanWrite } from '@/lib/subscription';
import { assertFeature } from '@/lib/features';
import { ownerId, ACCOUNT_SELECT, accountFieldsFrom, setDefaultAccount } from '@/lib/accounts';
import crypto from 'crypto';

// =====================================================================================
// 💰 ACCOUNTS — OWNER
// GET  -> the owner's accounts (newest first).
// POST -> add an account (cash / bank / MFS). The first account created becomes the default.
//
// Accounts is a paid module: BOTH verbs run assertFeature('accounts'). Gating only the writes
// would leave the list readable after an admin switches the add-on off.
// =====================================================================================

export async function GET(request: NextRequest) {
  try {
    const uid = ownerId(request);
    if (!uid) return NextResponse.json({ error: 'Context matching identity missing.' }, { status: 400 });

    const gate = await assertFeature(request.headers.get('x-rentmaster-role'), uid, 'accounts');
    if (!gate.ok) return NextResponse.json(gate.body, { status: gate.status });

    const { data, error } = await supabaseAdminEngine
      .from('accounts')
      .select(ACCOUNT_SELECT)
      .eq('owner_id', uid)
      .order('created_at', { ascending: false });
    if (error) throw error;

    return NextResponse.json({ success: true, count: data?.length || 0, data: data || [] }, { status: 200 });
  } catch (err: any) {
    console.error('[accounts] GET error:', err);
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const uid = ownerId(request);
    if (!uid) return NextResponse.json({ error: 'Context matching identity missing.' }, { status: 400 });

    const role = request.headers.get('x-rentmaster-role');

    const guard = await assertOwnerCanWrite(role, uid);
    if (!guard.ok) return NextResponse.json(guard.body, { status: guard.status });

    const gate = await assertFeature(role, uid, 'accounts');
    if (!gate.ok) return NextResponse.json(gate.body, { status: gate.status });

    const body = await request.json();
    const fields = accountFieldsFrom(body);
    if (!fields.name) {
      return NextResponse.json({ success: false, error: 'A name is required.' }, { status: 400 });
    }

    // The owner's very first account is the default automatically (so the automations have a target
    // out of the box); after that, is_default is only ever set through PATCH.
    const { count } = await supabaseAdminEngine
      .from('accounts')
      .select('id', { count: 'exact', head: true })
      .eq('owner_id', uid);
    const makeDefault = (count || 0) === 0;

    const { data: row, error: insertError } = await supabaseAdminEngine
      .from('accounts')
      .insert([{
        id: crypto.randomUUID(),
        owner_id: uid,
        ...fields,
        is_default: makeDefault,
      }])
      .select(ACCOUNT_SELECT)
      .single();

    if (insertError) {
      console.error('[accounts] insert failed:', insertError);
      return NextResponse.json({ success: false, error: insertError.message }, { status: 500 });
    }

    // Belt-and-braces: if the body asked to make it default (and it isn't already), apply it.
    if (!makeDefault && body.isDefault) {
      await setDefaultAccount(row.id, uid);
      (row as any).is_default = true;
    }

    return NextResponse.json({ success: true, data: row }, { status: 201 });
  } catch (err: any) {
    console.error('[accounts] POST crash:', err);
    return NextResponse.json({ success: false, error: err.message || 'Fatal Server Logic Exception.' }, { status: 500 });
  }
}
