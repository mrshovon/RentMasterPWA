import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { supabaseAdminEngine } from '@/lib/supabase-server';

// =====================================================================================
// CONTACT MESSAGES — ADMIN STATE MACHINE
// PATCH -> change status (new -> in_progress -> resolved / archived) and/or set an internal
//          note. Admin-only via the /api/super-admin/* gate in middleware.ts.
// =====================================================================================

const VALID_STATUS = ['new', 'in_progress', 'resolved', 'archived'];

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params; // params is a Promise in Next 16

    const { status, adminNotes } = await request.json();

    if (status === undefined && adminNotes === undefined) {
      return NextResponse.json({ success: false, error: 'Nothing to update.' }, { status: 400 });
    }
    if (status !== undefined && !VALID_STATUS.includes(status)) {
      return NextResponse.json(
        { success: false, error: `Status must be one of: ${VALID_STATUS.join(', ')}.` },
        { status: 400 },
      );
    }

    const updates: Record<string, any> = { updated_at: new Date().toISOString() };
    if (status !== undefined) updates.status = status;
    if (adminNotes !== undefined) updates.admin_notes = adminNotes || null;

    const { data: row, error } = await supabaseAdminEngine
      .from('contact_messages')
      .update(updates)
      .eq('id', id)
      .select('*')
      .single();

    if (error) {
      console.error('Admin Contact Message PATCH error:', error);
      return NextResponse.json({ success: false, error: error.message }, { status: 500 });
    }
    if (!row) {
      return NextResponse.json({ success: false, error: 'Message not found.' }, { status: 404 });
    }

    return NextResponse.json({ success: true, data: row }, { status: 200 });
  } catch (err: any) {
    console.error('Admin Contact Message PATCH crash:', err);
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}
