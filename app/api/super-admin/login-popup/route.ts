import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { getLoginPopup, setSetting, type LoginPopup } from '@/lib/app-settings';
import { apiError } from '@/lib/api-response';

// =====================================================================================
// 👋 LOGIN POPUP — ADMIN
// GET   -> the current popup, including its content while hidden, so it can be written and
//          previewed before being switched on.
// PATCH -> { enabled, titleEn, titleBn, bodyEn, bodyBn, imageUrl } (all optional; merged).
//
// Admin-only via the /api/super-admin/* gate in middleware.ts. The public read the popup uses
// lives at /api/app/login-popup and returns nothing at all while `enabled` is false.
// =====================================================================================

const MAX_TITLE = 120;
const MAX_BODY = 1000;

// The image must be a URL the browser will actually load over https, and it must be one WE issued.
// This popup is shown to STRANGERS on the sign-in screen, so an arbitrary attacker-supplied URL
// here is a tracking pixel pointed at everyone who ever reaches the front door.
// /api/admin/uploads returns Supabase storage URLs.
function parseImageUrl(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null;
  const raw = String(value);
  if (!/^https:\/\//i.test(raw)) throw new Error('The image URL must start with https://.');
  if (raw.length > 500) throw new Error('That image URL is too long.');
  return raw;
}

const text = (v: unknown, max: number) => String(v ?? '').trim().slice(0, max);

export async function GET(request: Request) {
  try {
    const data = await getLoginPopup();
    return NextResponse.json({ success: true, data }, { status: 200 });
  } catch (err) {
    return apiError(request, err);
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const body = await request.json();
    const current = await getLoginPopup();

    const next: LoginPopup = {
      enabled: body.enabled === undefined ? current.enabled : !!body.enabled,
      titleEn: body.titleEn === undefined ? current.titleEn : text(body.titleEn, MAX_TITLE),
      titleBn: body.titleBn === undefined ? current.titleBn : text(body.titleBn, MAX_TITLE),
      bodyEn: body.bodyEn === undefined ? current.bodyEn : text(body.bodyEn, MAX_BODY),
      bodyBn: body.bodyBn === undefined ? current.bodyBn : text(body.bodyBn, MAX_BODY),
      imageUrl: body.imageUrl === undefined ? current.imageUrl : parseImageUrl(body.imageUrl),
      updatedAt: new Date().toISOString(),
    };

    // An empty popup is a blank modal in front of every visitor, with no way for them to tell what
    // went wrong. Refuse to switch it on rather than ship that.
    const hasAnything =
      next.titleEn || next.titleBn || next.bodyEn || next.bodyBn || next.imageUrl;
    if (next.enabled && !hasAnything) {
      return NextResponse.json(
        { success: false, error: 'Add an image, a title or some details before switching the popup on.' },
        { status: 400 },
      );
    }

    // Bangla is not optional here the way it is for an internal tool: this is the first screen a
    // stranger sees, and half the audience reads Bangla. The English edition is allowed to stand in
    // at render time, but the admin should be told they are publishing a half-translated popup
    // rather than discovering it from a user.
    const missingBangla = next.enabled && (next.titleEn || next.bodyEn) && !next.titleBn && !next.bodyBn;

    await setSetting('login_popup', next);
    return NextResponse.json(
      {
        success: true,
        data: next,
        ...(missingBangla
          ? { warning: 'No Bangla text — Bangla readers will see the English version.' }
          : {}),
      },
      { status: 200 },
    );
  } catch (err: any) {
    console.error('Login popup PATCH error:', err);
    return NextResponse.json({ success: false, error: err.message }, { status: 400 });
  }
}
