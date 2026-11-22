import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { supabaseAdminEngine } from '@/lib/supabase-server';
import { assertOwnerCanWrite } from '@/lib/subscription';
import { apiError } from '@/lib/api-response';
import { normalizePayTo } from '@/lib/payment-claims';

// =====================================================================================
// 🚀 OWNER SETTINGS: system preferences stored on the owner's Supabase auth user_metadata
// (mirrors app/api/admin/owner/signature).
//   - whatsapp_message_template : the WhatsApp receipt message  ({tenant} {month} {amount} {status} {property})
//   - reminder_message_template : the rent-reminder default message ({tenant} {amount} {property} {month} {due_date})
//   - rent_pay_to               : where tenants send rent (account / QR / instructions / methods /
//                                 preselected default). It lives here rather than in app_settings
//                                 because it is PER OWNER, and the owner already controls this
//                                 metadata; the payers only ever get a read-only copy of it.
// GET  -> { whatsappMessageTemplate, reminderMessageTemplate, rentPayTo }
// POST { whatsappMessageTemplate?, reminderMessageTemplate?, rentPayTo? } -> saves only the keys provided
//        (merged into existing metadata so nothing else is lost).
// =====================================================================================

const MAX_TEMPLATE_LEN = 1000;

export async function GET(request: NextRequest) {
  try {
    const ownerId = request.headers.get('x-rentmaster-uid');
    if (!ownerId) return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 });

    const { data, error } = await supabaseAdminEngine.auth.admin.getUserById(ownerId);
    if (error) return apiError(request, error);

    const meta = (data?.user?.user_metadata as any) || {};
    return NextResponse.json({
      success: true,
      whatsappMessageTemplate: meta.whatsapp_message_template ?? null,
      reminderMessageTemplate: meta.reminder_message_template ?? null,
      rentPayTo: normalizePayTo(meta.rent_pay_to),
    }, { status: 200 });
  } catch (e) {
    return apiError(request, e);
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
    const hasPayTo = body.rentPayTo !== undefined && body.rentPayTo !== null;
    if (!hasWhatsapp && !hasReminder && !hasPayTo) {
      return NextResponse.json({ error: 'Provide at least one setting to save.' }, { status: 400 });
    }

    // Preserve existing metadata (name, phone, role, signature_url, the other template) while
    // updating only the provided key(s).
    const { data: current } = await supabaseAdminEngine.auth.admin.getUserById(ownerId);
    const meta: Record<string, any> = { ...((current?.user?.user_metadata as any) || {}) };
    if (hasWhatsapp) meta.whatsapp_message_template = String(body.whatsappMessageTemplate).slice(0, MAX_TEMPLATE_LEN);
    if (hasReminder) meta.reminder_message_template = String(body.reminderMessageTemplate).slice(0, MAX_TEMPLATE_LEN);
    if (hasPayTo) meta.rent_pay_to = normalizePayTo(body.rentPayTo);

    const { error } = await supabaseAdminEngine.auth.admin.updateUserById(ownerId, { user_metadata: meta });
    if (error) return apiError(request, error);

    return NextResponse.json({
      success: true,
      whatsappMessageTemplate: meta.whatsapp_message_template ?? null,
      reminderMessageTemplate: meta.reminder_message_template ?? null,
      rentPayTo: normalizePayTo(meta.rent_pay_to),
    }, { status: 200 });
  } catch (e) {
    return apiError(request, e);
  }
}
