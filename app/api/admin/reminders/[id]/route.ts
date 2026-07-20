import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { supabaseAdminEngine } from '@/lib/supabase-server';
import { deliverReminder, type ReminderRow } from '@/lib/reminders';

// =====================================================================================
// RENT REMINDERS — OWNER, single-reminder actions.
// PATCH { action: 'cancel' | 'send_now' } · DELETE. All scoped to the owner's own reminders.
// =====================================================================================

function ownerId(request: NextRequest): string | null {
  const id = request.headers.get('x-rentmaster-uid');
  if (!id || id === 'YOUR_ACTUAL_USER_UUID_FROM_DATABASE') return null;
  return id;
}

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params; // params is a Promise in Next 16
    const uid = ownerId(request);
    if (!uid) return NextResponse.json({ error: 'Context matching identity missing.' }, { status: 400 });

    const { action } = await request.json();
    if (!['cancel', 'send_now'].includes(action)) {
      return NextResponse.json({ success: false, error: "action must be 'cancel' or 'send_now'." }, { status: 400 });
    }

    // Fetch owner-scoped so one owner can't touch another's reminder.
    const { data: reminder, error: readErr } = await supabaseAdminEngine
      .from('reminders')
      .select('*')
      .eq('id', id)
      .eq('owner_id', uid)
      .single();
    if (readErr || !reminder) {
      return NextResponse.json({ success: false, error: 'Reminder not found.' }, { status: 404 });
    }

    if (action === 'cancel') {
      const { data, error } = await supabaseAdminEngine
        .from('reminders')
        .update({ status: 'canceled', updated_at: new Date().toISOString() })
        .eq('id', id)
        .select('*')
        .single();
      if (error) throw error;
      return NextResponse.json({ success: true, data }, { status: 200 });
    }

    // send_now
    let delivered = 0;
    try {
      delivered = await deliverReminder(reminder as ReminderRow);
    } catch (e: any) {
      return NextResponse.json({ success: false, error: e.message || 'Delivery failed.' }, { status: 500 });
    }
    const { data: fresh } = await supabaseAdminEngine.from('reminders').select('*').eq('id', id).single();
    return NextResponse.json({ success: true, delivered, data: fresh }, { status: 200 });
  } catch (err: any) {
    console.error('[reminders] PATCH crash:', err);
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const uid = ownerId(request);
    if (!uid) return NextResponse.json({ error: 'Context matching identity missing.' }, { status: 400 });

    const { error } = await supabaseAdminEngine
      .from('reminders')
      .delete()
      .eq('id', id)
      .eq('owner_id', uid);
    if (error) throw error;
    return NextResponse.json({ success: true }, { status: 200 });
  } catch (err: any) {
    console.error('[reminders] DELETE crash:', err);
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}
