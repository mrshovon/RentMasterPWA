import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { supabaseAdminEngine } from '../../../../lib/supabase-server';
import { assertOwnerCanWrite } from '../../../../lib/subscription';
import crypto from 'crypto';
import { apiError } from '@/lib/api-response';
import { fontExtOf, hasFontSignature, FONT_CONTENT_TYPE, FONT_EXTS } from '@/lib/font-validate';

// =====================================================================================
// 🚀 STORAGE UPLOAD ENGINE: accepts a multipart image (or, for the fonts folder, a font
// file) and pushes it into the public RentMasterProDocs bucket via the service-role
// client, returning the public URL that callers store on a record (e.g.
// maintenance_logs.attachment_file_url, or app_settings.font_config).
// =====================================================================================
const STORAGE_BUCKET = 'RentMasterProDocs';
const MAX_FILE_BYTES = 8 * 1024 * 1024; // 8MB — mirrors the middleware cap for this path
const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/jpg', 'image/webp', 'image/gif'];
// PDFs are allowed for TENANT DOCUMENTS only — deeds, agreements and receipts arrive as PDFs far
// more often than as photos. Every other surface stays image-only on purpose: a PDF uploaded as
// the owner's signature or as the bKash QR would render as a broken image on the receipt and the
// payment screen, and neither of those has a client-side type check to stop it getting that far.
const PDF_FOLDERS = ['documents'];

// FONTS are their own branch further down, not another entry in the list above, because for
// a font neither the browser's Content-Type nor a MIME allow-list is trustworthy: Chrome
// sends font/woff2 for .woff2 but routinely application/octet-stream (or nothing at all) for
// .ttf and .otf. Accepting octet-stream in the shared list would have made this route an
// arbitrary-file-upload endpoint for a PUBLIC bucket. So fonts are checked by extension and
// by their first four bytes instead, and stored under a content type we choose.
const FONT_FOLDER = 'fonts';
const MAX_FONT_BYTES = 2 * 1024 * 1024; // a webfont that big is already a mistake

export async function POST(request: NextRequest) {
  try {
    // Identity is injected by middleware; presence of either header is enough here.
    const ownerId = request.headers.get('x-rentmaster-uid');
    const tenantId = request.headers.get('x-rentmaster-tenant-id');
    if (!ownerId && !tenantId) {
      return NextResponse.json({ error: 'Context identity signature parameter extraction missing.' }, { status: 400 });
    }

    // Owner write-lock (tenant uploads use role 'tenant' and pass through).
    const guard = await assertOwnerCanWrite(request.headers.get('x-rentmaster-role'), ownerId);
    if (!guard.ok) return NextResponse.json(guard.body, { status: guard.status });

    const formData = await request.formData();
    const file = formData.get('file');

    if (!file || typeof file === 'string') {
      return NextResponse.json({ error: 'No file field present in the multipart payload.' }, { status: 400 });
    }

    const blob = file as File;

    // Optional caller-provided sub-folder (defaults to a generic bucket path). Resolved BEFORE
    // the type check, because what counts as an acceptable type depends on it.
    const folderRaw = (formData.get('folder') as string) || 'maintenance';
    const folder = folderRaw.replace(/[^a-z0-9_-]/gi, '') || 'maintenance';

    const isFont = folder === FONT_FOLDER;
    const fontExt = isFont ? fontExtOf(blob.name || '') : null;

    let ext: string;
    // What we tell the bucket to serve it as. For a font this is OURS, not the browser's
    // guess — an octet-stream font still loads today, but a wrong content type is exactly the
    // kind of thing that breaks one browser a year from now for no discoverable reason.
    let contentType: string;

    if (isFont) {
      if (!fontExt) {
        return NextResponse.json({
          error: `Unsupported font file. Use one of: ${FONT_EXTS.join(', ')}.`,
        }, { status: 400 });
      }
      if (blob.size > MAX_FONT_BYTES) {
        return NextResponse.json({ error: 'Font files are limited to 2MB.' }, { status: 413 });
      }
      ext = fontExt;
      contentType = FONT_CONTENT_TYPE[fontExt];
    } else {
      const pdfAllowed = PDF_FOLDERS.includes(folder);
      const allowedTypes = pdfAllowed ? [...IMAGE_TYPES, 'application/pdf'] : IMAGE_TYPES;

      if (!allowedTypes.includes(blob.type)) {
        const accepted = pdfAllowed ? 'PDF or images (png, jpg, webp, gif)' : 'Images only (png, jpg, webp, gif)';
        return NextResponse.json({ error: `Unsupported file type '${blob.type}'. ${accepted}.` }, { status: 400 });
      }
      if (blob.size > MAX_FILE_BYTES) {
        return NextResponse.json({ error: 'File exceeds the 8MB upload limit.' }, { status: 413 });
      }

      ext = (blob.name?.split('.').pop() || blob.type.split('/').pop() || 'png').toLowerCase().replace(/[^a-z0-9]/g, '');
      contentType = blob.type;
    }

    const arrayBuffer = await blob.arrayBuffer();

    // The filename said .woff2; this says the bytes agree. The bucket is public and CDN-served,
    // so without this check an admin account is an arbitrary-file-host.
    if (fontExt && !hasFontSignature(new Uint8Array(arrayBuffer.slice(0, 4)), fontExt)) {
      return NextResponse.json({
        error: `That file is named .${fontExt} but does not contain a font.`,
      }, { status: 400 });
    }

    const objectPath = `${folder}/${crypto.randomUUID()}.${ext}`;

    const { error: uploadError } = await supabaseAdminEngine
      .storage
      .from(STORAGE_BUCKET)
      .upload(objectPath, arrayBuffer, { contentType, upsert: false });

    if (uploadError) {
      return apiError(request, uploadError);
    }

    const { data: publicUrlData } = supabaseAdminEngine
      .storage
      .from(STORAGE_BUCKET)
      .getPublicUrl(objectPath);

    return NextResponse.json({ success: true, url: publicUrlData.publicUrl, path: objectPath }, { status: 201 });

  } catch (runtimeExceptionCatch) {
    return apiError(request, runtimeExceptionCatch);
  }
}
