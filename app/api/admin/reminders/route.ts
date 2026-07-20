import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { supabaseAdminEngine } from '@/lib/supabase-server';
import { assertOwnerCanWrite } from '@/lib/subscription';
import { deliverReminder, type ReminderRow } from '@/lib/reminders';
import crypto from 'crypto';

// =====================================================================================
// RENT REMINDERS — OWNER
// GET  -> the owner's reminders (newest first).
// POST -> schedule a reminder for one/many tenants (or all), once or monthly. If the date is
//         today or past, it delivers immediately; a future date is left for the cron.
// =====================================================================================

function ownerId(request: NextRequest): string | null {
  const id = request.headers.get('x-rentmaster-uid');
  if (!id || id === 'YOUR_ACTUAL_USER_UUID_FROM_DATABASE') return null;
  return id;
}

const todayStr = () => new Date().toISOString().slice(0, 10);

export async function GET(request: NextRequest) {
  try {
    const uid = ownerId(request);
    if (!uid) return NextResponse.json({ error: 'Context matching identity missing.' }, { status: 400 });

    const { data, error } = await supabaseAdminEngine
      .from('reminders')
      .select('*')
      .eq('owner_id', uid)
      .order('created_at', { ascending: false });
    if (error) throw error;

    return NextResponse.json({ success: true, count: data?.length || 0, data: data || [] }, { status: 200 });
  } catch (err: any) {
    console.error('[reminders] GET error:', err);
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const uid = ownerId(request);
    if (!uid) return NextResponse.json({ error: 'Context matching identity missing.' }, { status: 400 });

    const guard = await assertOwnerCanWrite(request.headers.get('x-rentmaster-role'), uid);
    if (!guard.ok) return NextResponse.json(guard.body, { status: guard.status });

    const body = await request.json();
    const message = String(body.message || '').trim();
    const targetAll = !!body.targetAll;
    const tenantIds: string[] = Array.isArray(body.tenantIds) ? body.tenantIds : [];
    const scheduledDate = String(body.scheduledDate || '').slice(0, 10);
    const recurrence = body.recurrence === 'monthly' ? 'monthly' : 'once';

    if (!message) return NextResponse.json({ success: false, error: 'A message is required.' }, { status: 400 });
    if (!/^\d{4}-\d{2}-\d{2}$/.test(scheduledDate)) {
      return NextResponse.json({ success: false, error: 'A valid date is required.' }, { status: 400 });
    }
    if (!targetAll && tenantIds.length === 0) {
      return NextResponse.json({ success: false, error: 'Select at least one tenant.' }, { status: 400 });
    }

    // Validate the chosen tenants actually belong to this owner (ignore any that don't).
    let validIds: string[] = [];
    if (!targetAll) {
      const { data: owned } = await supabaseAdminEngine
        .from('tenants')
        .select('id')
        .eq('owner_id', uid)
        .in('id', tenantIds);
      validIds = (owned || []).map((t) => t.id);
      if (validIds.length === 0) {
        return NextResponse.json({ success: false, error: 'None of the selected tenants are yours.' }, { status: 400 });
      }
    }

    const id = crypto.randomUUID();
    const { data: row, error: insertError } = await supabaseAdminEngine
      .from('reminders')
      .insert([{
        id,
        owner_id: uid,
        target_all: targetAll,
        tenant_ids: targetAll ? [] : validIds,
        message,
        scheduled_date: scheduledDate,
        recurrence,
        status: 'pending',
      }])
      .select('*')
      .single();

    if (insertError) {
      console.error('[reminders] insert failed:', insertError);
      return NextResponse.json({ success: false, error: insertError.message }, { status: 500 });
    }

    // Same-day/past: deliver now for instant feedback. Future: the cron picks it up.
    let delivered = 0;
    if (scheduledDate <= todayStr()) {
      try {
        delivered = await deliverReminder(row as ReminderRow);
      } catch (e) {
        console.error('[reminders] immediate delivery failed (non-fatal):', e);
      }
    }

    // Re-read so the response reflects any status/date change from immediate delivery.
    const { data: fresh } = await supabaseAdminEngine.from('reminders').select('*').eq('id', id).single();
    return NextResponse.json({ success: true, delivered, data: fresh || row }, { status: 201 });
  } catch (err: any) {
    console.error('[reminders] POST crash:', err);
    return NextResponse.json({ success: false, error: err.message || 'Fatal Server Logic Exception.' }, { status: 500 });
  }
}
