import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { supabaseAdminEngine } from '@/lib/supabase-server';
import { sendPushToUsers } from '@/lib/push-send';

// =====================================================================================
// SUPPORT TICKETS — ADMIN STATE MACHINE
// PATCH -> advance status (submitted -> assigned -> in_progress -> done) and/or leave a
//          resolution note. Stamps assigned_to/assigned_at on first claim and finished_at
//          on completion. Admin-only via the /api/super-admin/* gate in middleware.ts.
// =====================================================================================

const VALID_STATUS = ['submitted', 'assigned', 'in_progress', 'done'];

const STATUS_LABEL: Record<string, string> = {
  submitted: 'Submitted',
  assigned: 'Assigned',
  in_progress: 'In progress',
  done: 'Done',
};

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id: ticketId } = await params; // params is a Promise in Next 16
    const adminId = request.headers.get('x-rentmaster-uid');

    const { status, adminRemarks } = await request.json();

    if (status === undefined && adminRemarks === undefined) {
      return NextResponse.json({ success: false, error: 'Nothing to update.' }, { status: 400 });
    }
    if (status !== undefined && !VALID_STATUS.includes(status)) {
      return NextResponse.json(
        { success: false, error: `Status must be one of: ${VALID_STATUS.join(', ')}.` },
        { status: 400 },
      );
    }

    // Read the row first: we need owner_id to push, and assigned_to to know if it is already claimed.
    const { data: existing, error: readError } = await supabaseAdminEngine
      .from('support_tickets')
      .select('id, owner_id, subject, status, assigned_to')
      .eq('id', ticketId)
      .single();

    if (readError || !existing) {
      return NextResponse.json({ success: false, error: 'Ticket not found.' }, { status: 404 });
    }

    const updates: Record<string, any> = { updated_at: new Date().toISOString() };
    if (adminRemarks !== undefined) updates.admin_remarks = adminRemarks || null;

    if (status !== undefined) {
      updates.status = status;

      // First move off 'submitted' claims the ticket for the acting admin. Covers both
      // "click Assign" and "jump straight to In progress".
      if (status !== 'submitted' && !existing.assigned_to && adminId) {
        updates.assigned_to = adminId;
        updates.assigned_at = new Date().toISOString();
      }

      // finished_at tracks completion, and is cleared again if the ticket is re-opened,
      // so the column never claims a resolution that was undone.
      if (status === 'done') {
        updates.finished_at = new Date().toISOString();
      } else if (existing.status === 'done') {
        updates.finished_at = null;
      }
    }

    const { data: ticket, error: updateError } = await supabaseAdminEngine
      .from('support_tickets')
      .update(updates)
      .eq('id', ticketId)
      .select('*')
      .single();

    if (updateError) {
      console.error('Admin Support Ticket PATCH error:', updateError);
      return NextResponse.json({ success: false, error: updateError.message }, { status: 500 });
    }

    // Tell the owner their ticket moved. Fire-and-forget: never fail the response.
    if (status !== undefined && status !== existing.status) {
      try {
        await sendPushToUsers([existing.owner_id], {
          title: 'Support ticket updated',
          body: `"${existing.subject}" is now ${STATUS_LABEL[status] || status}.`,
          url: '/owner#support',
          tag: `ticket-${ticketId}`,
        });
      } catch (pushErr) {
        console.error('[support-tickets] push dispatch failed (non-fatal):', pushErr);
      }
    }

    return NextResponse.json({ success: true, data: ticket }, { status: 200 });
  } catch (err: any) {
    console.error('Admin Support Ticket PATCH crash:', err);
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}
