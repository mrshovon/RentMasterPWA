import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { supabaseAdminEngine } from '@/lib/supabase-server';
import { apiError } from '@/lib/api-response';

// =====================================================================================
// ✅ OWNER — ACKNOWLEDGE A PLAN LIFECYCLE EVENT
// POST { eventId } -> stamps plan_events.seen_at, so the "your plan has ended" modal is shown
//                     once and never again.
//
// Deliberately NOT behind assertOwnerCanWrite, like its parent /api/admin/subscription: the
// owner this most concerns is precisely the one whose plan just lapsed, and a guard that stopped
// them dismissing the notice about their own downgrade would trap them behind it forever.
//
// Scoped by `owner_id = uid` in the update itself, so an owner can only ever acknowledge their
// own event even if they send someone else's id.
// =====================================================================================

export async function POST(request: NextRequest) {
  try {
    const uid = request.headers.get('x-rentmaster-uid');
    if (!uid) return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 });

    const { eventId } = await request.json();
    if (!eventId) return NextResponse.json({ error: 'eventId is required.' }, { status: 400 });

    const { error } = await supabaseAdminEngine
      .from('plan_events')
      .update({ seen_at: new Date().toISOString() })
      .eq('id', eventId)
      .eq('owner_id', uid);   // ownership check and filter in one
    if (error) throw error;

    return NextResponse.json({ success: true }, { status: 200 });
  } catch (err) {
    return apiError(request, err);
  }
}
