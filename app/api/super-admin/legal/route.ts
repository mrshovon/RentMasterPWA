import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { apiError } from '@/lib/api-response';
import {
  LEGAL_DOC_NAMES, LEGAL_LANGS, getLegalDoc, setLegalDoc,
  getTermsVersion, setTermsVersion,
  type LegalDocName, type LegalLang,
} from '@/lib/app-settings';

// =====================================================================================
// 👑 SUPER ADMIN — THE LEGAL DOCUMENTS
// GET   -> all four documents' saved markdown (null where nothing has been saved) + the version
// PATCH -> { doc, lang, markdown }  and/or  { effectiveDate }
//
// Until now the Terms and the Privacy Policy could only be changed by editing markdown in
// ../legal/, re-running `npm run build:legal` and deploying. That is why every [PLACEHOLDER] in
// them is still unfilled.
//
// WHAT IS STORED IS AN OVERRIDE, NOT THE DOCUMENT. The compiled text remains the fallback, so
// `markdown: null` here means "go back to the built-in version" rather than "the policy is now
// blank" — which is the one state a published privacy policy must never be in.
//
// No auth code here on purpose: middleware.ts gates every /api/super-admin/* path on
// user_metadata.role === 'admin' and returns 403 before a handler ever runs.
// =====================================================================================

/**
 * These documents run to tens of kilobytes — the Bangla Terms are 62 KB — so the short-string
 * caps used elsewhere in the settings routes would reject a legitimate save. This ceiling exists
 * only to stop a runaway paste filling a jsonb column, and sits well above any real document.
 */
const MAX_MARKDOWN = 400_000;

/** Effective dates are printed at the top of the documents and stored on every consent row. */
const MAX_VERSION = 60;

function parseDoc(v: unknown): LegalDocName | null {
  return LEGAL_DOC_NAMES.includes(v as LegalDocName) ? (v as LegalDocName) : null;
}
function parseLang(v: unknown): LegalLang | null {
  return LEGAL_LANGS.includes(v as LegalLang) ? (v as LegalLang) : null;
}

export async function GET(request: NextRequest) {
  try {
    // Four rows, one round trip each. Deliberately not a single `in` query: getLegalDoc() carries
    // the fallback shape, and this route runs once when an admin opens a settings card.
    const docs: Record<string, { markdown: string | null; updatedAt: string }> = {};
    for (const doc of LEGAL_DOC_NAMES) {
      for (const lang of LEGAL_LANGS) {
        const saved = await getLegalDoc(doc, lang);
        docs[`${doc}_${lang}`] = {
          // null, not '' — the editor shows the compiled text as a placeholder when there is no
          // override, and needs to tell "never saved" from "saved as empty".
          markdown: saved.markdown ? saved.markdown : null,
          updatedAt: saved.updatedAt || '',
        };
      }
    }

    return NextResponse.json(
      { success: true, data: { docs, termsVersion: await getTermsVersion() } },
      { status: 200 }
    );
  } catch (err) {
    return apiError(request, err);
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const body = await request.json();

    // The effective date can be saved on its own — an admin correcting a date has not necessarily
    // touched a word of the text.
    if (body.effectiveDate !== undefined) {
      const version = String(body.effectiveDate ?? '').trim().slice(0, MAX_VERSION);
      await setTermsVersion(version);
      if (body.doc === undefined) {
        return NextResponse.json(
          { success: true, message: 'Effective date updated.', termsVersion: await getTermsVersion() },
          { status: 200 }
        );
      }
    }

    const doc = parseDoc(body.doc);
    const lang = parseLang(body.lang);
    if (!doc || !lang) {
      return NextResponse.json(
        { success: false, error: 'doc must be "privacy" or "terms" and lang must be "en" or "bn".' },
        { status: 400 }
      );
    }

    // null clears the override. An all-whitespace body is treated the same way rather than
    // published: saving a blank Terms page is never what someone meant to do.
    const raw = body.markdown === null ? '' : String(body.markdown ?? '');
    if (raw.length > MAX_MARKDOWN) {
      return NextResponse.json(
        { success: false, error: `That document is too large (limit ${MAX_MARKDOWN.toLocaleString()} characters).` },
        { status: 413 }
      );
    }
    const markdown = raw.trim() ? raw : '';

    await setLegalDoc(doc, lang, markdown);

    return NextResponse.json(
      {
        success: true,
        message: markdown ? 'Document published.' : 'Reverted to the built-in text.',
        termsVersion: await getTermsVersion(),
      },
      { status: 200 }
    );
  } catch (err) {
    return apiError(request, err);
  }
}
