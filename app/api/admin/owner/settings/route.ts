import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { supabaseAdminEngine } from '@/lib/supabase-server';
import { assertOwnerCanWrite } from '@/lib/subscription';

// =====================================================================================
// 🚀 OWNER SETTINGS: system preferences stored on the owner's Supabase auth user_metadata
// (mirrors app/api/admin/owner/signature). For now: the WhatsApp receipt message template.
// GET  -> { whatsappMessageTemplate }
// POST { whatsappMessageTemplate } -> saves it (merged into existing metadata)
//
// Template supports placeholder tokens resolved at send time on the client:
//   {tenant} {month} {amount} {status} {property}
// =====================================================================================

const MAX_TEMPLATE_LEN = 1000;

export async function GET(request: NextRequest) {
  try {
    const ownerId = request.headers.get('x-rentmaster-uid');
    if (!ownerId) return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 });

    const { data, error } = await supabaseAdminEngine.auth.admin.getUserById(ownerId);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    const whatsappMessageTemplate = (data?.user?.user_metadata as any)?.whatsapp_message_template ?? null;
    return NextResponse.json({ success: true, whatsappMessageTemplate }, { status: 200 });
  } catch (e: any) {
    console.error('Owner Settings GET Crash:', e);
    return NextResponse.json({ error: e.message || 'Fatal Server Logic Exception.' }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const ownerId = request.headers.get('x-rentmaster-uid');
    if (!ownerId) return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 });
    const guard = await assertOwnerCanWrite(request.headers.get('x-rentmaster-role'), ownerId);
    if (!guard.ok) return NextResponse.json(guard.body, { status: guard.status });

    const body = await request.json();
    const raw = body.whatsappMessageTemplate;
    if (typeof raw !== 'string') {
      return NextResponse.json({ error: 'whatsappMessageTemplate must be a string.' }, { status: 400 });
    }
    const template = raw.slice(0, MAX_TEMPLATE_LEN);

    // Preserve existing metadata (name, phone, role, signature_url) while setting the template.
    const { data: current } = await supabaseAdminEngine.auth.admin.getUserById(ownerId);
    const meta = { ...((current?.user?.user_metadata as any) || {}), whatsapp_message_template: template };

    const { error } = await supabaseAdminEngine.auth.admin.updateUserById(ownerId, { user_metadata: meta });
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    return NextResponse.json({ success: true, whatsappMessageTemplate: template }, { status: 200 });
  } catch (e: any) {
    console.error('Owner Settings POST Crash:', e);
    return NextResponse.json({ error: e.message || 'Fatal Server Logic Exception.' }, { status: 500 });
  }
}
