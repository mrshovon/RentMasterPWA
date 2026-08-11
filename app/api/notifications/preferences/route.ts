import { NextResponse } from 'next/server';
import { supabaseAdminEngine } from '@/lib/supabase-server';
import { DEFAULT_PUSH_SOUND, type PushSound } from '@/lib/push-send';
import { apiError } from '@/lib/api-response';

// =====================================================================================
// 🔔 NOTIFICATION PREFERENCES — the signed-in person's own settings.
//
// GET -> { sound }.  PUT { sound } -> saves it.
//
// Works for owners, tenants and admins alike: identity is injected + verified by middleware
// (client-supplied x-rentmaster-* headers are stripped there), and `user_id` is read the same
// way /api/notifications/register does — uid for an auth user, tenant id for a tenant JWT — so
// the row lines up with `device_tokens.user_id` and lib/push-send.ts can join the two.
//
// Storage: notification_prefs (ADD_NOTIFICATION_PREFS.sql). Deliberately NOT user_metadata,
// which tenants do not have.
// =====================================================================================

const SOUNDS: PushSound[] = ['custom', 'default', 'off'];

function identify(request: Request): string | null {
  return request.headers.get('x-rentmaster-uid') || request.headers.get('x-rentmaster-tenant-id');
}

export async function GET(request: Request) {
  try {
    const userId = identify(request);
    if (!userId) return NextResponse.json({ success: false, error: 'Unauthorized.' }, { status: 401 });

    const { data, error } = await supabaseAdminEngine
      .from('notification_prefs')
      .select('sound')
      .eq('user_id', userId)
      .maybeSingle();

    // A missing table or a missing row both mean "never chosen" — answer with the default rather
    // than an error, so the Settings card renders instead of showing a failure on a fresh account.
    if (error) console.warn('[notification-prefs] read failed:', error.message);
    const sound = (data?.sound as PushSound) || DEFAULT_PUSH_SOUND;
    return NextResponse.json({ success: true, data: { sound } }, { status: 200 });
  } catch (err) {
    return apiError(request, err);
  }
}

export async function PUT(request: Request) {
  try {
    const userId = identify(request);
    if (!userId) return NextResponse.json({ success: false, error: 'Unauthorized.' }, { status: 401 });

    const body = await request.json();
    const sound = String(body?.sound || '') as PushSound;
    if (!SOUNDS.includes(sound)) {
      return NextResponse.json(
        { success: false, error: `sound must be one of: ${SOUNDS.join(', ')}.` },
        { status: 400 },
      );
    }

    const { error } = await supabaseAdminEngine
      .from('notification_prefs')
      .upsert({ user_id: userId, sound, updated_at: new Date().toISOString() }, { onConflict: 'user_id' });
    if (error) throw error;

    return NextResponse.json({ success: true, data: { sound } }, { status: 200 });
  } catch (err) {
    return apiError(request, err);
  }
}
