import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { supabaseAdminEngine } from '@/lib/supabase-server';
import { sendPushToRole } from '@/lib/push-send';
import crypto from 'crypto';

// =====================================================================================
// SUPPORT TICKETS — OWNER SIDE
// GET  -> the calling owner's own tickets
// POST -> raise a new ticket (always starts at 'submitted')
//
// Lives under /api/admin/ because middleware.ts only authenticates and injects the
// x-rentmaster-* identity headers for /api/admin/, /api/super-admin/ and /api/notifications/.
// =====================================================================================

const VALID_CATEGORY = ['billing', 'technical', 'account', 'feature_request', 'other'];
const VALID_PRIORITY = ['low', 'medium', 'high', 'urgent'];

export async function POST(request: NextRequest) {
  try {
    const ownerId = request.headers.get('x-rentmaster-uid');
    const tenantHeaderId = request.headers.get('x-rentmaster-tenant-id');

    // Tickets are an owner-to-admin channel; tenants raise maintenance logs instead.
    if (tenantHeaderId) {
      return NextResponse.json({ error: 'Tenants cannot raise support tickets.' }, { status: 403 });
    }
    if (!ownerId) {
      return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 });
    }

    // NOTE: deliberately no assertOwnerCanWrite() here. Every other write route blocks a
    // locked/expired owner, but a locked owner is exactly who needs to reach support.

    const body = await request.json();
    const { subject, description, category, priority, attachmentFileUrls } = body;

    if (!subject?.trim() || !description?.trim()) {
      return NextResponse.json({ error: 'A subject and a description are required.' }, { status: 400 });
    }
    if (category && !VALID_CATEGORY.includes(category)) {
      return NextResponse.json({ error: `Category must be one of: ${VALID_CATEGORY.join(', ')}.` }, { status: 400 });
    }
    if (priority && !VALID_PRIORITY.includes(priority)) {
      return NextResponse.json({ error: `Priority must be one of: ${VALID_PRIORITY.join(', ')}.` }, { status: 400 });
    }

    // Attachments share the maintenance_logs storage shape: a lone URL as a plain string,
    // several as a JSON array. lib/format.ts parseAttachments() reads both back.
    const urls: string[] = (Array.isArray(attachmentFileUrls) ? attachmentFileUrls : []).filter(
      (u: unknown): u is string => typeof u === 'string' && u.trim() !== '',
    );
    const attachmentValue =
      urls.length === 0 ? null : urls.length === 1 ? urls[0] : JSON.stringify(urls);

    const ticketId = crypto.randomUUID(); // no DB default on id — generate it here

    const { data: ticket, error: insertError } = await supabaseAdminEngine
      .from('support_tickets')
      .insert([
        {
          id: ticketId,
          owner_id: ownerId,
          subject: subject.trim(),
          description: description.trim(),
          category: category || 'other',
          priority: priority || 'medium',
          status: 'submitted',
          attachment_file_url: attachmentValue,
        },
      ])
      .select('*')
      .single();

    if (insertError) {
      console.error('[support-tickets] insert failed:', insertError);
      return NextResponse.json({ error: insertError.message }, { status: 500 });
    }

    // Buzz the system admins. Fire-and-forget: a push failure must never fail the ticket.
    try {
      await sendPushToRole('admin', {
        title: `New ${ticket.priority}-priority support ticket`,
        body: ticket.subject,
        url: '/admin#tickets',
        tag: `ticket-${ticketId}`,
      });
    } catch (pushErr) {
      console.error('[support-tickets] push dispatch failed (non-fatal):', pushErr);
    }

    return NextResponse.json({ success: true, data: ticket }, { status: 201 });
  } catch (err: any) {
    console.error('[support-tickets] POST crash:', err);
    return NextResponse.json({ error: err.message || 'Fatal Server Logic Exception.' }, { status: 500 });
  }
}

export async function GET(request: NextRequest) {
  try {
    const ownerId = request.headers.get('x-rentmaster-uid');
    const tenantHeaderId = request.headers.get('x-rentmaster-tenant-id');

    if (tenantHeaderId) {
      return NextResponse.json({ error: 'Tenants cannot view support tickets.' }, { status: 403 });
    }
    if (!ownerId) {
      return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 });
    }

    const { data: tickets, error } = await supabaseAdminEngine
      .from('support_tickets')
      .select('*')
      .eq('owner_id', ownerId)
      .order('created_at', { ascending: false });

    if (error) {
      console.error('[support-tickets] list failed:', error);
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json(
      { success: true, count: tickets?.length || 0, data: tickets || [] },
      { status: 200 },
    );
  } catch (err: any) {
    console.error('[support-tickets] GET crash:', err);
    return NextResponse.json({ error: err.message || 'Fatal Server Logic Exception.' }, { status: 500 });
  }
}
