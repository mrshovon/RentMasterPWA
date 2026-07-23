import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { supabaseAdminEngine } from '@/lib/supabase-server';
import { assertOwnerCanWrite } from '@/lib/subscription';
import { assertFeature } from '@/lib/features';
import {
  ownerId, TXN_SELECT, TXN_DIRECTIONS, txnFieldsFrom, ownsAccount, resolveOwnerPropertyId,
} from '@/lib/accounts';
import crypto from 'crypto';

// =====================================================================================
// 💵 ACCOUNT TRANSACTIONS — OWNER (income & expense)
// GET  -> the owner's entries (newest first). Optional ?accountId= to scope to one account.
// POST -> record a manual income or expense (always source = 'manual').
//
// Filtering by property/month happens client-side over the loaded array (same as Billing),
// so the list route only needs the owner scope.
// =====================================================================================

export async function GET(request: NextRequest) {
  try {
    const uid = ownerId(request);
    if (!uid) return NextResponse.json({ error: 'Context matching identity missing.' }, { status: 400 });

    const gate = await assertFeature(request.headers.get('x-rentmaster-role'), uid, 'accounts');
    if (!gate.ok) return NextResponse.json(gate.body, { status: gate.status });

    const accountId = request.nextUrl.searchParams.get('accountId');

    let query = supabaseAdminEngine
      .from('account_transactions')
      .select(TXN_SELECT)
      .eq('owner_id', uid)
      .order('txn_date', { ascending: false })
      .order('created_at', { ascending: false });
    if (accountId) query = query.eq('account_id', accountId);

    const { data, error } = await query;
    if (error) throw error;

    return NextResponse.json({ success: true, count: data?.length || 0, data: data || [] }, { status: 200 });
  } catch (err: any) {
    console.error('[accounts/transactions] GET error:', err);
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
    const fields = txnFieldsFrom(body);

    const accountId = String(body.accountId || '').trim();
    if (!accountId) {
      return NextResponse.json({ success: false, error: 'An account is required.' }, { status: 400 });
    }
    if (!(await ownsAccount(accountId, uid))) {
      return NextResponse.json({ success: false, error: 'Account not found.' }, { status: 404 });
    }
    if (!TXN_DIRECTIONS.includes(fields.direction as any)) {
      return NextResponse.json({ success: false, error: 'Choose income or expense.' }, { status: 400 });
    }
    const amount = Number(fields.amount);
    if (!Number.isFinite(amount) || amount <= 0) {
      return NextResponse.json({ success: false, error: 'Enter an amount greater than zero.' }, { status: 400 });
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(fields.txn_date || ''))) {
      return NextResponse.json({ success: false, error: 'A valid date is required.' }, { status: 400 });
    }

    let propertyId: string | null | undefined;
    try {
      propertyId = await resolveOwnerPropertyId(body, uid);
    } catch (e: any) {
      return NextResponse.json({ success: false, error: e.message }, { status: 400 });
    }

    const { data: row, error: insertError } = await supabaseAdminEngine
      .from('account_transactions')
      .insert([{
        id: crypto.randomUUID(),
        owner_id: uid,
        account_id: accountId,
        property_id: propertyId ?? null,
        ...fields,
        source: 'manual',
        source_ref: null,
      }])
      .select(TXN_SELECT)
      .single();

    if (insertError) {
      console.error('[accounts/transactions] insert failed:', insertError);
      return NextResponse.json({ success: false, error: insertError.message }, { status: 500 });
    }

    return NextResponse.json({ success: true, data: row }, { status: 201 });
  } catch (err: any) {
    console.error('[accounts/transactions] POST crash:', err);
    return NextResponse.json({ success: false, error: err.message || 'Fatal Server Logic Exception.' }, { status: 500 });
  }
}
