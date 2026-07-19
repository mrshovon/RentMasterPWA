import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { supabaseAdminEngine } from '@/lib/supabase-server';
import { sendPushToRole } from '@/lib/push-send';
import crypto from 'crypto';

// =====================================================================================
// CONTACT MESSAGES — OWNER SIDE
// POST -> send a "Contact us" enquiry (from the custom/Whole-Building plan card).
//
// Lives under /api/admin/ because middleware.ts only authenticates and injects the
// x-rentmaster-* identity headers for /api/admin/, /api/super-admin/ and /api/notifications/.
// Deliberately NO assertOwnerCanWrite(): a locked/expired owner is exactly who wants to reach
// sales, mirroring the support-tickets rationale.
// =====================================================================================

const MAX_MESSAGE_LEN = 2000;

export async function POST(request: NextRequest) {
  try {
    const ownerId = request.headers.get('x-rentmaster-uid');
    const tenantHeaderId = request.headers.get('x-rentmaster-tenant-id');

    if (tenantHeaderId) {
      return NextResponse.json({ error: 'Tenants cannot send contact enquiries.' }, { status: 403 });
    }
    if (!ownerId) {
      return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 });
    }

    const body = await request.json();
    const { name, email, phone, tierId, message } = body;

    if (!message?.trim()) {
      return NextResponse.json({ error: 'A message is required.' }, { status: 400 });
    }

    const messageId = crypto.randomUUID(); // no DB default on id — generate it here

    const { data: row, error: insertError } = await supabaseAdminEngine
      .from('contact_messages')
      .insert([
        {
          id: messageId,
          owner_id: ownerId,
          name: name?.trim() || null,
          email: email?.trim() || null,
          phone: phone?.trim() || null,
          tier_id: tierId || null,
          message: String(message).trim().slice(0, MAX_MESSAGE_LEN),
          status: 'new',
        },
      ])
      .select('*')
      .single();

    if (insertError) {
      console.error('[contact-messages] insert failed:', insertError);
      return NextResponse.json({ error: insertError.message }, { status: 500 });
    }

    // Buzz the system admins. Fire-and-forget: a push failure must never fail the enquiry.
    try {
      await sendPushToRole('admin', {
        title: 'New contact enquiry',
        body: (name?.trim() ? `${name.trim()}: ` : '') + String(message).trim().slice(0, 80),
        url: '/admin#messages',
        tag: `contact-${messageId}`,
      });
    } catch (pushErr) {
      console.error('[contact-messages] push dispatch failed (non-fatal):', pushErr);
    }

    return NextResponse.json({ success: true, data: row }, { status: 201 });
  } catch (err: any) {
    console.error('[contact-messages] POST crash:', err);
    return NextResponse.json({ error: err.message || 'Fatal Server Logic Exception.' }, { status: 500 });
  }
}
