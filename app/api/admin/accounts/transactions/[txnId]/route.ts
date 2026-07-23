import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { supabaseAdminEngine } from '@/lib/supabase-server';
import { assertOwnerCanWrite } from '@/lib/subscription';
import { assertFeature } from '@/lib/features';
import { ownerId } from '@/lib/accounts';

// =====================================================================================
// 💵 ACCOUNT TRANSACTION — DELETE (OWNER)
// Removes a mis-entered income/expense. Scoped by owner_id so one owner can never delete
// another's. Auto-booked rows (source != 'manual') can be deleted here too — the automation
// won't recreate them unless the source event fires again.
// =====================================================================================

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ txnId: string }> }) {
  try {
    const { txnId } = await params;
    const uid = ownerId(request);
    if (!uid) return NextResponse.json({ error: 'Context matching identity missing.' }, { status: 400 });

    const role = request.headers.get('x-rentmaster-role');

    const guard = await assertOwnerCanWrite(role, uid);
    if (!guard.ok) return NextResponse.json(guard.body, { status: guard.status });

    const gate = await assertFeature(role, uid, 'accounts');
    if (!gate.ok) return NextResponse.json(gate.body, { status: gate.status });

    const { data: existing } = await supabaseAdminEngine
      .from('account_transactions')
      .select('id')
      .eq('id', txnId)
      .eq('owner_id', uid)
      .maybeSingle();
    if (!existing) {
      return NextResponse.json({ success: false, error: 'Transaction not found.' }, { status: 404 });
    }

    const { error } = await supabaseAdminEngine
      .from('account_transactions')
      .delete()
      .eq('id', txnId)
      .eq('owner_id', uid);
    if (error) throw error;

    return NextResponse.json({ success: true, message: 'Transaction deleted.' }, { status: 200 });
  } catch (err: any) {
    console.error('[accounts/transactions/:id] DELETE error:', err);
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}
