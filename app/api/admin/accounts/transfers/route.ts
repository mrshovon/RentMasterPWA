import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { supabaseAdminEngine } from '@/lib/supabase-server';
import { assertOwnerCanWrite } from '@/lib/subscription';
import { assertFeature } from '@/lib/features';
import { ownerId, TRANSFER_SELECT, ownsAccount } from '@/lib/accounts';
import crypto from 'crypto';

// =====================================================================================
// 🔁 ACCOUNT TRANSFERS — OWNER
// GET  -> the owner's transfers (newest first).
// POST -> move money between two of the owner's own accounts.
//
// Transfers are NEUTRAL to income/expense: they change each account's balance but never count
// as income or expense (that's why they live in their own table — see ADD_ACCOUNTS.sql).
// =====================================================================================

export async function GET(request: NextRequest) {
  try {
    const uid = ownerId(request);
    if (!uid) return NextResponse.json({ error: 'Context matching identity missing.' }, { status: 400 });

    const gate = await assertFeature(request.headers.get('x-rentmaster-role'), uid, 'accounts');
    if (!gate.ok) return NextResponse.json(gate.body, { status: gate.status });

    const { data, error } = await supabaseAdminEngine
      .from('account_transfers')
      .select(TRANSFER_SELECT)
      .eq('owner_id', uid)
      .order('txn_date', { ascending: false })
      .order('created_at', { ascending: false });
    if (error) throw error;

    return NextResponse.json({ success: true, count: data?.length || 0, data: data || [] }, { status: 200 });
  } catch (err: any) {
    console.error('[accounts/transfers] GET error:', err);
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
    const fromAccountId = String(body.fromAccountId || '').trim();
    const toAccountId = String(body.toAccountId || '').trim();
    const amount = Number(body.amount);
    const txnDate = String(body.txnDate || '').slice(0, 10);
    const note = String(body.note ?? '').trim() || null;

    if (!fromAccountId || !toAccountId) {
      return NextResponse.json({ success: false, error: 'Both accounts are required.' }, { status: 400 });
    }
    if (fromAccountId === toAccountId) {
      return NextResponse.json({ success: false, error: 'Choose two different accounts.' }, { status: 400 });
    }
    if (!Number.isFinite(amount) || amount <= 0) {
      return NextResponse.json({ success: false, error: 'Enter an amount greater than zero.' }, { status: 400 });
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(txnDate)) {
      return NextResponse.json({ success: false, error: 'A valid date is required.' }, { status: 400 });
    }
    // Both accounts must be this owner's — never trust an id from the body.
    if (!(await ownsAccount(fromAccountId, uid)) || !(await ownsAccount(toAccountId, uid))) {
      return NextResponse.json({ success: false, error: 'Account not found.' }, { status: 404 });
    }

    const { data: row, error: insertError } = await supabaseAdminEngine
      .from('account_transfers')
      .insert([{
        id: crypto.randomUUID(),
        owner_id: uid,
        from_account_id: fromAccountId,
        to_account_id: toAccountId,
        amount,
        txn_date: txnDate,
        note,
      }])
      .select(TRANSFER_SELECT)
      .single();

    if (insertError) {
      console.error('[accounts/transfers] insert failed:', insertError);
      return NextResponse.json({ success: false, error: insertError.message }, { status: 500 });
    }

    return NextResponse.json({ success: true, data: row }, { status: 201 });
  } catch (err: any) {
    console.error('[accounts/transfers] POST crash:', err);
    return NextResponse.json({ success: false, error: err.message || 'Fatal Server Logic Exception.' }, { status: 500 });
  }
}
