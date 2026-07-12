import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { supabaseAdminEngine } from '../../../../lib/supabase-server';
import { assertOwnerCanWrite } from '../../../../lib/subscription';
import crypto from 'crypto';

// =====================================================================================
// 🚀 STORAGE UPLOAD ENGINE: accepts a multipart image and pushes it into the public
// RentMasterProDocs bucket via the service-role client, returning the public URL that
// callers store on a record (e.g. maintenance_logs.attachment_file_url).
// =====================================================================================
const STORAGE_BUCKET = 'RentMasterProDocs';
const MAX_FILE_BYTES = 8 * 1024 * 1024; // 8MB — mirrors the middleware cap for this path
const ALLOWED_TYPES = ['image/png', 'image/jpeg', 'image/jpg', 'image/webp', 'image/gif'];

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

    if (!ALLOWED_TYPES.includes(blob.type)) {
      return NextResponse.json({ error: `Unsupported file type '${blob.type}'. Images only (png, jpg, webp, gif).` }, { status: 400 });
    }
    if (blob.size > MAX_FILE_BYTES) {
      return NextResponse.json({ error: 'File exceeds the 8MB upload limit.' }, { status: 413 });
    }

    // Optional caller-provided sub-folder (defaults to a generic bucket path).
    const folderRaw = (formData.get('folder') as string) || 'maintenance';
    const folder = folderRaw.replace(/[^a-z0-9_-]/gi, '') || 'maintenance';

    const ext = (blob.name?.split('.').pop() || blob.type.split('/').pop() || 'png').toLowerCase().replace(/[^a-z0-9]/g, '');
    const objectPath = `${folder}/${crypto.randomUUID()}.${ext}`;

    const arrayBuffer = await blob.arrayBuffer();
    const { error: uploadError } = await supabaseAdminEngine
      .storage
      .from(STORAGE_BUCKET)
      .upload(objectPath, arrayBuffer, { contentType: blob.type, upsert: false });

    if (uploadError) {
      console.error('Supabase Storage Upload Failure:', uploadError);
      return NextResponse.json({ error: uploadError.message }, { status: 500 });
    }

    const { data: publicUrlData } = supabaseAdminEngine
      .storage
      .from(STORAGE_BUCKET)
      .getPublicUrl(objectPath);

    return NextResponse.json({ success: true, url: publicUrlData.publicUrl, path: objectPath }, { status: 201 });

  } catch (runtimeExceptionCatch: any) {
    console.error('Fatal Pipeline Execution Storage Upload Route Crash:', runtimeExceptionCatch);
    return NextResponse.json({ error: runtimeExceptionCatch.message || 'Fatal Server Logic Exception.' }, { status: 500 });
  }
}
