import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { LOGIN_POPUP_KEY } from '@/lib/app-settings';
import { savePopupList, readPopupListForAdmin, PopupValidationError } from '@/lib/popup-write';
import { apiError } from '@/lib/api-response';

// =====================================================================================
// 👋 LOGIN BANNERS — ADMIN
// GET -> the whole list, drafts included, so banners can be written and previewed before going up.
// PUT -> { items: PopupItem[] } replaces the list.
//
// Admin-only via the /api/super-admin/* gate in middleware.ts. The public read lives at
// /api/app/login-popup and strips every inactive item.
//
// Same validation as the announcement route, from lib/popup-write.ts. These banners face people
// with no account at all, which is why the image-URL guard in there is not optional.
// =====================================================================================

export async function GET(request: Request) {
  try {
    return NextResponse.json(
      { success: true, data: await readPopupListForAdmin(LOGIN_POPUP_KEY) },
      { status: 200 },
    );
  } catch (err) {
    return apiError(request, err);
  }
}

export async function PUT(request: NextRequest) {
  try {
    const body = await request.json();
    const data = await savePopupList(LOGIN_POPUP_KEY, body?.items);

    // Bangla is not optional here the way it is for an internal tool: this is the first screen a
    // stranger sees. The English edition stands in at render time, but the admin should be told
    // they are publishing half-translated banners rather than hearing it from a user.
    const missingBangla = data.items.some(
      (i) => i.active && (i.titleEn || i.bodyEn) && !i.titleBn && !i.bodyBn,
    );

    return NextResponse.json(
      {
        success: true,
        data,
        ...(missingBangla
          ? { warning: 'Some banners have no Bangla text — Bangla readers will see the English version.' }
          : {}),
      },
      { status: 200 },
    );
  } catch (err: any) {
    if (err instanceof PopupValidationError) {
      return NextResponse.json({ success: false, error: err.message }, { status: 400 });
    }
    if (err?.message?.includes('image URL')) {
      return NextResponse.json({ success: false, error: err.message }, { status: 400 });
    }
    return apiError(request, err);
  }
}
