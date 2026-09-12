import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { ANNOUNCEMENT_KEY } from '@/lib/app-settings';
import { savePopupList, readPopupListForAdmin, PopupValidationError } from '@/lib/popup-write';
import { apiError } from '@/lib/api-response';

// =====================================================================================
// 📢 ANNOUNCEMENTS — ADMIN
// GET -> the whole list, drafts included, so items can be written and previewed before being
//        switched on.
// PUT -> { items: PopupItem[] } replaces the list.
//
// Admin-only via the /api/super-admin/* gate in middleware.ts. The public read the popup uses
// lives at /api/app/announcement and strips every inactive item.
//
// Validation, caps and id assignment are in lib/popup-write.ts, shared with the login-banner
// route — the two take the same payload and must not drift on what counts as valid.
// =====================================================================================

export async function GET(request: Request) {
  try {
    return NextResponse.json(
      { success: true, data: await readPopupListForAdmin(ANNOUNCEMENT_KEY) },
      { status: 200 },
    );
  } catch (err) {
    return apiError(request, err);
  }
}

export async function PUT(request: NextRequest) {
  try {
    const body = await request.json();
    const data = await savePopupList(ANNOUNCEMENT_KEY, body?.items);
    return NextResponse.json({ success: true, data }, { status: 200 });
  } catch (err: any) {
    if (err instanceof PopupValidationError) {
      return NextResponse.json({ success: false, error: err.message }, { status: 400 });
    }
    // parseImageUrl throws a plain Error for a bad URL — also the admin's to fix, not a fault.
    if (err?.message?.includes('image URL')) {
      return NextResponse.json({ success: false, error: err.message }, { status: 400 });
    }
    return apiError(request, err);
  }
}
