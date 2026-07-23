import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { supabaseAdminEngine } from '@/lib/supabase-server';
import { assertOwnerCanWrite } from '@/lib/subscription';
import { assertFeature } from '@/lib/features';
import { ownerId, ACCOUNT_SELECT, accountFieldsFrom, ownsAccount, setDefaultAccount } from '@/lib/accounts';

// =====================================================================================
// 💰 ACCOUNT — SINGLE RECORD (OWNER)
// GET    -> one account
// PATCH  -> edit details / set as default / activate-deactivate
// DELETE -> remove the account (its transactions and transfers cascade with it)
//
// Every handler re-scopes by owner_id, so an id belonging to another owner reads as "not
// found" rather than leaking or mutating their row.
// =====================================================================================

const notFound = () =>
  NextResponse.json({ success: false, error: 'Account not found.' }, { status: 404 });

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const uid = ownerId(request);
    if (!uid) return NextResponse.json({ error: 'Context matching identity missing.' }, { status: 400 });

    const gate = await assertFeature(request.headers.get('x-rentmaster-role'), uid, 'accounts');
    if (!gate.ok) return NextResponse.json(gate.body, { status: gate.status });

    const { data: row } = await supabaseAdminEngine
      .from('accounts')
      .select(ACCOUNT_SELECT)
      .eq('id', id)
      .eq('owner_id', uid)
      .maybeSingle();
    if (!row) return notFound();

    return NextResponse.json({ success: true, data: row }, { status: 200 });
  } catch (err: any) {
    console.error('[accounts/:id] GET error:', err);
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const uid = ownerId(request);
    if (!uid) return NextResponse.json({ error: 'Context matching identity missing.' }, { status: 400 });

    const role = request.headers.get('x-rentmaster-role');

    const guard = await assertOwnerCanWrite(role, uid);
    if (!guard.ok) return NextResponse.json(guard.body, { status: guard.status });

    const gate = await assertFeature(role, uid, 'accounts');
    if (!gate.ok) return NextResponse.json(gate.body, { status: gate.status });

    if (!(await ownsAccount(id, uid))) return notFound();

    const body = await request.json();

    // Setting the default is its own path (only one default per owner) — handle it first so the
    // plain-field update below never touches is_default.
    if (body.isDefault === true) {
      await setDefaultAccount(id, uid);
    }

    const fields = accountFieldsFrom(body);
    if ('name' in fields && !fields.name) {
      return NextResponse.json({ success: false, error: 'A name is required.' }, { status: 400 });
    }

    if (Object.keys(fields).length > 0) {
      fields.updated_at = new Date().toISOString();
      const { error } = await supabaseAdminEngine
        .from('accounts')
        .update(fields)
        .eq('id', id)
        .eq('owner_id', uid);
      if (error) throw error;
    } else if (body.isDefault !== true) {
      return NextResponse.json({ success: false, error: 'Nothing to update.' }, { status: 400 });
    }

    const { data: row, error: readError } = await supabaseAdminEngine
      .from('accounts')
      .select(ACCOUNT_SELECT)
      .eq('id', id)
      .eq('owner_id', uid)
      .single();
    if (readError) throw readError;

    return NextResponse.json({ success: true, data: row }, { status: 200 });
  } catch (err: any) {
    console.error('[accounts/:id] PATCH error:', err);
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const uid = ownerId(request);
    if (!uid) return NextResponse.json({ error: 'Context matching identity missing.' }, { status: 400 });

    const role = request.headers.get('x-rentmaster-role');

    const guard = await assertOwnerCanWrite(role, uid);
    if (!guard.ok) return NextResponse.json(guard.body, { status: guard.status });

    const gate = await assertFeature(role, uid, 'accounts');
    if (!gate.ok) return NextResponse.json(gate.body, { status: gate.status });

    if (!(await ownsAccount(id, uid))) return notFound();

    // account_transactions and account_transfers rows go with it (on delete cascade — see
    // ADD_ACCOUNTS.sql). Any auto-booked income/expense in this account is removed too.
    const { error } = await supabaseAdminEngine
      .from('accounts')
      .delete()
      .eq('id', id)
      .eq('owner_id', uid);
    if (error) throw error;

    return NextResponse.json({ success: true, message: 'Account removed.' }, { status: 200 });
  } catch (err: any) {
    console.error('[accounts/:id] DELETE error:', err);
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}
