import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { supabaseAdminEngine } from '../../../../../lib/supabase-server';
import { assertOwnerCanWrite } from '../../../../../lib/subscription';
import { sendPushToUsers } from '../../../../../lib/push-send';

// ==============================================================================
// 🚀 MAINTENANCE MUTATOR: owner updates a ticket's resolution status + remarks.
// (Requires maintenance_logs.resolution_remarks — run the documents/remarks migration.)
// ==============================================================================
const VALID_STATUS = ['reported', 'in_progress', 'resolved'];

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: logId } = await params;
    if (!logId) {
      return NextResponse.json({ error: 'Maintenance ticket identifier missing.' }, { status: 400 });
    }

    const guard = await assertOwnerCanWrite(
      request.headers.get('x-rentmaster-role'),
      request.headers.get('x-rentmaster-uid'),
    );
    if (!guard.ok) return NextResponse.json(guard.body, { status: guard.status });

    const body = await request.json();
    const { resolutionStatus, resolutionRemarks } = body;

    const updates: Record<string, any> = {};
    if (resolutionStatus !== undefined) {
      if (!VALID_STATUS.includes(resolutionStatus)) {
        return NextResponse.json({ error: "Status must be 'reported', 'in_progress' or 'resolved'." }, { status: 400 });
      }
      updates.resolution_status = resolutionStatus;
    }
    if (resolutionRemarks !== undefined) {
      updates.resolution_remarks = resolutionRemarks || null;
    }

    if (Object.keys(updates).length === 0) {
      return NextResponse.json({ error: 'No fields supplied to update.' }, { status: 400 });
    }

    const { data, error } = await supabaseAdminEngine
      .from('maintenance_logs')
      .update(updates)
      .eq('id', logId)
      .select('*, properties:property_id ( name, owner_id ), tenants:tenant_id ( name, phone )')
      .single();

    if (error) {
      console.error('Supabase Maintenance Update Error:', error);
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    // Tell the tenant who raised it that the status moved. Fire-and-forget: a push
    // failure must never fail the status change.
    if (updates.resolution_status && data?.tenant_id) {
      const statusLabel = String(updates.resolution_status).replace('_', ' ');
      try {
        await sendPushToUsers([data.tenant_id], {
          title: `Request ${statusLabel}`,
          body: `"${data.issue_title}" is now ${statusLabel}.`,
          url: '/tenant',
          tag: `maintenance-${logId}`,
        });
      } catch (pushErr) {
        console.error('[maintenance] tenant push dispatch failed (non-fatal):', pushErr);
      }
    }

    return NextResponse.json({ success: true, data }, { status: 200 });
  } catch (e: any) {
    console.error('Maintenance PATCH Route Crash:', e);
    return NextResponse.json({ error: e.message || 'Fatal Server Logic Exception.' }, { status: 500 });
  }
}
