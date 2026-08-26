import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import {
  LEGAL_DOC_NAMES, LEGAL_LANGS, getLegalDoc, getTermsVersion,
  DEFAULT_TERMS_VERSION, type LegalDocName, type LegalLang,
} from '@/lib/app-settings';

// =====================================================================================
// 📄 LEGAL DOCUMENT OVERRIDE (public read)
// GET ?doc=terms|privacy&lang=en|bn -> { markdown: string | null, version }
//
// Public on purpose, and it has to be: /privacy and /terms are readable signed out — Google Play
// requires the privacy URL to resolve for anyone — so this answers before a session exists.
// middleware.ts only gates /api/admin, /api/super-admin and /api/notifications; it adds CORS to
// everything else under /api/ on the way through.
//
// `markdown: null` means "no override — render the compiled document you already have". The
// browser ships the built-in text inside its bundle, so a null here is a complete answer, not a
// missing one.
//
// FAILS OPEN, like /api/app/maintenance. Every error path returns null rather than a status code:
// a settings-table hiccup must leave the published policy readable, and the client cannot tell
// the difference because the fallback is what it renders either way.
//
// Not cached at the edge: an admin who corrects a legal document expects the corrected text to be
// what the next reader sees, not what a CDN decided to keep.
// =====================================================================================

export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'no-store' };

export async function GET(request: NextRequest) {
  try {
    const params = request.nextUrl.searchParams;
    const doc = params.get('doc') as LegalDocName | null;
    const lang = params.get('lang') as LegalLang | null;

    // An unknown doc/lang is answered with the fallback, not a 400. The only caller is our own
    // page; anything else asking is noise, and noise should not produce an error to handle.
    if (!doc || !lang || !LEGAL_DOC_NAMES.includes(doc) || !LEGAL_LANGS.includes(lang)) {
      return NextResponse.json(
        { success: true, markdown: null, version: DEFAULT_TERMS_VERSION },
        { status: 200, headers: NO_STORE }
      );
    }

    const saved = await getLegalDoc(doc, lang);
    return NextResponse.json(
      {
        success: true,
        markdown: saved.markdown ? saved.markdown : null,
        updatedAt: saved.updatedAt || '',
        version: await getTermsVersion(),
      },
      { status: 200, headers: NO_STORE }
    );
  } catch (err: any) {
    console.error('[legal] read failed:', err);
    return NextResponse.json(
      { success: true, markdown: null, version: DEFAULT_TERMS_VERSION },
      { status: 200, headers: NO_STORE }
    );
  }
}
