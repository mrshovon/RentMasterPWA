import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import {
  getFontConfig, setFontConfig, normaliseFontConfig,
  CURATED_LATIN_IDS, CURATED_BANGLA_IDS, type FontSlot,
} from '@/lib/app-settings';
import { isSafeFontUrl } from '@/lib/font-validate';
import { apiError } from '@/lib/api-response';

// =====================================================================================
// 🛡️ ADMIN — SYSTEM FONTS
// GET -> the current config
// PUT -> replace it
//
// Admin-only via middleware.ts (all /api/super-admin/* requires role === 'admin').
// Stored in app_settings.font_config. Public read is a separate route, /api/app/font-config,
// which every client reads on load.
//
// normaliseFontConfig() already drops anything invalid, so this handler could simply save
// whatever survives. It does not: silently discarding a selection the admin made is how a
// settings page teaches people not to trust it. Anything that would be dropped is reported
// as a 400 naming the field instead.
// =====================================================================================

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  try {
    const config = await getFontConfig();
    return NextResponse.json({ success: true, data: config }, {
      status: 200, headers: { 'Cache-Control': 'no-store' },
    });
  } catch (err) {
    return apiError(request, err);
  }
}

/** Say exactly what was wrong with one slot, or null when it is fine. */
function slotComplaint(raw: any, label: string): string | null {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Partial<FontSlot>;

  const latin = String(r.latinId || '').trim().toLowerCase();
  if (latin && !CURATED_LATIN_IDS.has(latin)) {
    return `"${latin}" is not one of the English fonts we offer (${label}).`;
  }
  const bangla = String(r.banglaId || '').trim().toLowerCase();
  if (bangla && !CURATED_BANGLA_IDS.has(bangla)) {
    return `"${bangla}" is not one of the Bangla fonts we offer (${label}).`;
  }

  for (const [key, name] of [['customLatin', 'English'], ['customBangla', 'Bangla']] as const) {
    const c = (r as any)[key];
    if (c && !isSafeFontUrl(c?.url)) {
      return `The custom ${name} font address (${label}) must be an https link ending in .woff2, .woff, .ttf or .otf, with no spaces or quotes.`;
    }
  }
  return null;
}

export async function PUT(request: NextRequest) {
  try {
    const body = await request.json();

    for (const [slot, label] of [['body', 'body text'], ['heading', 'headings']] as const) {
      const complaint = slotComplaint(body?.[slot], label);
      if (complaint) {
        return NextResponse.json({ success: false, error: complaint }, { status: 400 });
      }
    }

    const stored = await setFontConfig(normaliseFontConfig(body));

    return NextResponse.json({
      success: true, data: stored,
      message: 'Fonts saved. Everyone sees them on their next app open.',
    }, { status: 200 });
  } catch (err) {
    return apiError(request, err);
  }
}
