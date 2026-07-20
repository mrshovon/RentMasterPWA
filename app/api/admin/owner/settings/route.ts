import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { supabaseAdminEngine } from '@/lib/supabase-server';
import { assertOwnerCanWrite } from '@/lib/subscription';

// =====================================================================================
// 🚀 OWNER SETTINGS: system preferences stored on the owner's Supabase auth user_metadata
// (mirrors app/api/admin/owner/signature).
//   - whatsapp_message_template : the WhatsApp receipt message  ({tenant} {month} {amount} {status} {property})
//   - reminder_message_template : the rent-reminder default message ({tenant} {amount} {property} {month} {due_date})
// GET  -> { whatsappMessageTemplate, reminderMessageTemplate }
// POST { whatsappMessageTemplate?, reminderMessageTemplate? } -> saves only the keys provided
//        (merged into existing metadata so nothing else is lost).
// =====================================================================================

const MAX_TEMPLATE_LEN = 1000;

export async function GET(request: NextRequest) {
  try {
    const ownerId = request.headers.get('x-rentmaster-uid');
    if (!ownerId) return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 });

    const { data, error } = await supabaseAdminEngine.auth.admin.getUserById(ownerId);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    const meta = (data?.user?.user_metadata as any) || {};
    return NextResponse.json({
      success: true,
      whatsappMessageTemplate: meta.whatsapp_message_template ?? null,
      reminderMessageTemplate: meta.reminder_message_template ?? null,
    }, { status: 200 });
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
    const hasWhatsapp = typeof body.whatsappMessageTemplate === 'string';
    const hasReminder = typeof body.reminderMessageTemplate === 'string';
    if (!hasWhatsapp && !hasReminder) {
      return NextResponse.json({ error: 'Provide whatsappMessageTemplate and/or reminderMessageTemplate (string).' }, { status: 400 });
    }

    // Preserve existing metadata (name, phone, role, signature_url, the other template) while
    // updating only the provided key(s).
    const { data: current } = await supabaseAdminEngine.auth.admin.getUserById(ownerId);
    const meta: Record<string, any> = { ...((current?.user?.user_metadata as any) || {}) };
    if (hasWhatsapp) meta.whatsapp_message_template = String(body.whatsappMessageTemplate).slice(0, MAX_TEMPLATE_LEN);
    if (hasReminder) meta.reminder_message_template = String(body.reminderMessageTemplate).slice(0, MAX_TEMPLATE_LEN);

    const { error } = await supabaseAdminEngine.auth.admin.updateUserById(ownerId, { user_metadata: meta });
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    return NextResponse.json({
      success: true,
      whatsappMessageTemplate: meta.whatsapp_message_template ?? null,
      reminderMessageTemplate: meta.reminder_message_template ?? null,
    }, { status: 200 });
  } catch (e: any) {
    console.error('Owner Settings POST Crash:', e);
    return NextResponse.json({ error: e.message || 'Fatal Server Logic Exception.' }, { status: 500 });
  }
}
