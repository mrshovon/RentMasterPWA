// =====================================================================================
// FONT VALIDATION — the rules that decide whether an admin-supplied font can be written
// into CSS. Duplicated verbatim at rent-master-pwa-ui/lib/font-validate.ts.
//
// The two repos deploy separately and share no package, so this file is copied rather than
// imported — the same arrangement lib/validate.ts already has. Keep them byte-identical:
// the backend refuses bad input on save, and the frontend refuses it again before it
// touches a stylesheet. Either one alone would be a single point of failure.
//
// WHAT THIS GUARDS. A font setting ends up inside `font-family:` and `url("…")`. A value
// that can close either one is arbitrary CSS on every page of the app — the same class of
// hole the analytics feature refuses to open by never accepting a script snippet (see
// components/analytics-gate.tsx). So: the family names are OURS, never the admin's, and the
// URL is checked structurally AND for the handful of characters that can terminate a rule.
// =====================================================================================

/** Catalog ids — the only thing stored for a curated font. Anchored. */
export const FONT_ID_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;

/**
 * The family names a custom face may be declared under. FIXED, never admin-supplied.
 *
 * An earlier design took a family name from the admin and validated it with a character
 * class. This is strictly better: there is no input to validate, so there is no way for a
 * family name to be anything but one of these four strings.
 */
export const CUSTOM_FAMILIES = [
  'Bari360 Custom Latin',
  'Bari360 Custom Bangla',
  'Bari360 Custom Latin Heading',
  'Bari360 Custom Bangla Heading',
] as const;
export type CustomFamily = (typeof CUSTOM_FAMILIES)[number];

export const isCustomFamily = (v: string): v is CustomFamily =>
  (CUSTOM_FAMILIES as readonly string[]).includes(v);

/** The `format()` token that goes in the @font-face src. */
export type FontFormat = 'woff2' | 'woff' | 'truetype' | 'opentype';

const EXT_TO_FORMAT: Record<string, FontFormat> = {
  woff2: 'woff2',
  woff: 'woff',
  ttf: 'truetype',
  otf: 'opentype',
};

/** File extensions we accept, for the upload route and the URL check. */
export const FONT_EXTS = ['woff2', 'woff', 'ttf', 'otf'] as const;
export type FontExt = (typeof FONT_EXTS)[number];

/**
 * The format token for a URL, or null when the extension is not one we serve.
 *
 * Read off `pathname` rather than the whole string on purpose: a signed or versioned URL
 * (`…/x.woff2?token=…`) is perfectly valid and an `endsWith('.woff2')` test would reject it.
 */
export function fontFormatFor(raw: string): FontFormat | null {
  try {
    const ext = new URL(raw).pathname.split('.').pop()?.toLowerCase() ?? '';
    return EXT_TO_FORMAT[ext] ?? null;
  } catch {
    return null;
  }
}

/**
 * A URL we are willing to write into `url("…")`.
 *
 * Structural parse first (so `javascript:`, `data:` and anything malformed die immediately),
 * then a deny-list of exactly the characters that can end the url(), the declaration or the
 * rule. Everything else is inert inside a quoted url(), so a deny-list is the honest shape
 * here — an allow-list would have to enumerate every character a CDN path may contain.
 *
 * https only: a font is a cross-origin subresource on every page, and an http one would be
 * blocked as mixed content in the deployed app anyway.
 */
export function isSafeFontUrl(raw: unknown): raw is string {
  if (typeof raw !== 'string') return false;
  if (raw.length < 12 || raw.length > 500) return false;
  if (/["'()\;{}<>\s]/.test(raw)) return false;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol !== 'https:') return false;
  return fontFormatFor(raw) !== null;
}

/**
 * First-bytes signatures, by extension.
 *
 * The upload bucket is PUBLIC, so "is this actually a font" is a real control and not a
 * nicety: without it the upload route is an arbitrary-file-to-a-public-CDN primitive for
 * whoever holds the admin account. The browser's own Content-Type cannot do this job —
 * Chrome reports `font/woff2` for .woff2 but routinely sends `application/octet-stream`
 * for .ttf and .otf.
 */
const SIGNATURES: Record<FontExt, number[][]> = {
  woff2: [[0x77, 0x4f, 0x46, 0x32]],                      // "wOF2"
  woff: [[0x77, 0x4f, 0x46, 0x46]],                       // "wOFF"
  otf: [[0x4f, 0x54, 0x54, 0x4f]],                        // "OTTO" (CFF outlines)
  // Either the version-1.0 sfnt header or the old "true" tag. "OTTO" is accepted too: a
  // CFF-flavoured file named .ttf is common and renders fine.
  ttf: [[0x00, 0x01, 0x00, 0x00], [0x74, 0x72, 0x75, 0x65], [0x4f, 0x54, 0x54, 0x4f]],
};

export function hasFontSignature(head: Uint8Array, ext: FontExt): boolean {
  const want = SIGNATURES[ext];
  if (!want || head.length < 4) return false;
  return want.some((sig) => sig.every((b, i) => head[i] === b));
}

/** The extension of an uploaded filename, lowercased, or null when it is not one of ours. */
export function fontExtOf(filename: string): FontExt | null {
  const ext = (filename.split('.').pop() || '').toLowerCase();
  return (FONT_EXTS as readonly string[]).includes(ext) ? (ext as FontExt) : null;
}

/** What we store the file as, regardless of what the browser guessed on the way in. */
export const FONT_CONTENT_TYPE: Record<FontExt, string> = {
  woff2: 'font/woff2',
  woff: 'font/woff',
  ttf: 'font/ttf',
  otf: 'font/otf',
};
