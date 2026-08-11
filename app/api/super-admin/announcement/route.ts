import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { getAnnouncement, setSetting, type Announcement } from '@/lib/app-settings';
import { apiError } from '@/lib/api-response';

// =====================================================================================
// 📢 ANNOUNCEMENT — ADMIN
// GET   -> the current announcement (including the content while it is hidden, so it can be
//          edited and previewed before being switched on).
// PATCH -> { enabled, title, body, imageUrl } (all optional; merged over what's stored).
//
// Admin-only via the /api/super-admin/* gate in middleware.ts. The public read the popup uses
// lives at /api/app/announcement and returns nothing at all while `enabled` is false.
// =====================================================================================

const MAX_TITLE = 120;
const MAX_BODY = 1000;

// The image must be a URL the browser will actually load over https, and it must be one WE issued.
// Storing an arbitrary attacker-supplied URL here would put a remote image in front of every user
// of the app on open — a tracking pixel at best. /api/admin/uploads returns Supabase storage URLs.
function parseImageUrl(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null;
  const raw = String(value);
  if (!/^https:\/\//i.test(raw)) throw new Error('The image URL must start with https://.');
  if (raw.length > 500) throw new Error('That image URL is too long.');
  return raw;
}

export async function GET(request: Request) {
  try {
    const data = await getAnnouncement();
    return NextResponse.json({ success: true, data }, { status: 200 });
  } catch (err) {
    return apiError(request, err);
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const body = await request.json();
    const current = await getAnnouncement();

    const next: Announcement = {
      enabled: body.enabled === undefined ? current.enabled : !!body.enabled,
      title: body.title === undefined ? current.title : String(body.title).trim().slice(0, MAX_TITLE),
      body: body.body === undefined ? current.body : String(body.body).trim().slice(0, MAX_BODY),
      imageUrl: body.imageUrl === undefined ? current.imageUrl : parseImageUrl(body.imageUrl),
      updatedAt: new Date().toISOString(),
    };

    // An empty popup is a blank modal in front of every user with no way for them to tell what
    // went wrong. Refuse to switch it on rather than ship that.
    if (next.enabled && !next.title && !next.body && !next.imageUrl) {
      return NextResponse.json(
        { success: false, error: 'Add an image, a title or some details before switching the announcement on.' },
        { status: 400 },
      );
    }

    await setSetting('announcement', next);
    return NextResponse.json({ success: true, data: next }, { status: 200 });
  } catch (err: any) {
    console.error('Announcement PATCH error:', err);
    return NextResponse.json({ success: false, error: err.message }, { status: 400 });
  }
}
