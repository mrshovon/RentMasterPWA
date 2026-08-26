import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { supabaseAdminEngine } from '@/lib/supabase-server';
import { sendPushToRole } from '@/lib/push-send';
import { validateEmail, validatePhone } from '@/lib/validate';
import { clientIpFrom } from '@/lib/password-reset-log';
import crypto from 'crypto';
import { apiError } from '@/lib/api-response';

// =====================================================================================
// ✉️ CONTACT US — PUBLIC (from the /plans pricing page)
// POST { name, email, phone, tierId, message } -> a contact_messages row with owner_id NULL.
//
// WHY THIS EXISTS SEPARATELY FROM /api/admin/contact-messages. That route needs the identity
// headers middleware only injects under /api/admin/, so it 401s for anyone without an account —
// and the most valuable card on the public pricing page is the Whole Building tier, whose only
// call to action is "contact us". A prospect who cannot sign in had no way to reach us at all.
//
// ⚠️ THIS IS THE SECOND ROUTE IN THE APP WHERE AN ANONYMOUS CALLER CAN WRITE A DATABASE ROW
// (the other is /api/logs). It is therefore throttled per IP with the same in-memory shape, caps
// every field, and stores no free-form HTML. Requires contact_messages.owner_id to be nullable —
// see ADD_PUBLIC_CONTACT.sql, which must be run BEFORE this deploys.
//
// Unlike /api/logs this does NOT answer unconditionally: a person filling in a contact form has
// to be told whether it was sent, so a refusal is a real status code with a readable message.
// =====================================================================================

export const dynamic = 'force-dynamic';

const MAX_MESSAGE_LEN = 2000;
const MAX_NAME_LEN = 120;
/** Deliberately tighter than /api/logs' 20: a human fills this in once, not twenty times a minute. */
const MAX_PER_WINDOW = 5;
const WINDOW_MS = 15 * 60 * 1000;

// Same in-memory shape as the login / forgot-password / logs throttles. Per-lambda and
// best-effort on serverless, which is the accepted trade-off documented in middleware.ts.
const hits = new Map<string, { count: number; firstAt: number }>();

function throttled(key: string): boolean {
  const now = Date.now();
  if (hits.size > 10000) {
    for (const [k, v] of hits) if (now - v.firstAt > WINDOW_MS) hits.delete(k);
  }
  const rec = hits.get(key);
  if (!rec || now - rec.firstAt > WINDOW_MS) {
    hits.set(key, { count: 1, firstAt: now });
    return false;
  }
  rec.count += 1;
  return rec.count > MAX_PER_WINDOW;
}

export async function POST(request: NextRequest) {
  try {
    const ip = clientIpFrom(request.headers) || 'unknown';
    if (throttled(ip)) {
      return NextResponse.json(
        { success: false, error: 'Too many enquiries from this connection. Please try again later.' },
        { status: 429 }
      );
    }

    const body = await request.json();
    const { name, email, phone, tierId, message } = body;

    if (!String(message ?? '').trim()) {
      return NextResponse.json({ success: false, error: 'A message is required.' }, { status: 400 });
    }

    // At least one way to reply. The authenticated route can fall back to the owner's account,
    // but here there is no account — an enquiry nobody can answer is worse than none, because it
    // looks to the sender like they have been heard.
    const parsedEmail = validateEmail(email);
    if (!parsedEmail.ok) return NextResponse.json({ success: false, error: parsedEmail.error }, { status: 400 });
    const parsedPhone = validatePhone(phone);
    if (!parsedPhone.ok) return NextResponse.json({ success: false, error: parsedPhone.error }, { status: 400 });
    if (!parsedEmail.value && !parsedPhone.value) {
      return NextResponse.json(
        { success: false, error: 'Please leave an email address or a phone number so we can reply.' },
        { status: 400 }
      );
    }

    const messageId = crypto.randomUUID(); // no DB default on id — generate it here

    const { data: row, error: insertError } = await supabaseAdminEngine
      .from('contact_messages')
      .insert([
        {
          id: messageId,
          // NULL is what marks this as a public enquiry. The admin Messages queue already renders
          // `m.name || m.owner?.name`, so a null owner displays correctly with no change there.
          owner_id: null,
          name: String(name ?? '').trim().slice(0, MAX_NAME_LEN) || null,
          email: parsedEmail.value || null,
          phone: parsedPhone.value || null,
          tier_id: tierId || null,
          message: String(message).trim().slice(0, MAX_MESSAGE_LEN),
          status: 'new',
        },
      ])
      .select('*')
      .single();

    if (insertError) {
      // 23502 = not-null violation: ADD_PUBLIC_CONTACT.sql has not been run. Say so plainly in the
      // log rather than leaving a generic 500 for someone to bisect.
      if ((insertError as any).code === '23502') {
        console.error('[public-contact] contact_messages.owner_id is still NOT NULL — run ADD_PUBLIC_CONTACT.sql.');
      }
      return apiError(request, insertError);
    }

    // Buzz the system admins. Fire-and-forget: a push failure must never fail the enquiry.
    try {
      await sendPushToRole('admin', {
        title: 'New enquiry from the pricing page',
        body: (String(name ?? '').trim() ? `${String(name).trim()}: ` : '') + String(message).trim().slice(0, 80),
        url: '/admin#messages',
        tag: `contact-${messageId}`,
      });
    } catch (pushErr) {
      console.error('[public-contact] push dispatch failed (non-fatal):', pushErr);
    }

    return NextResponse.json({ success: true, data: { id: row?.id ?? messageId } }, { status: 201 });
  } catch (err) {
    return apiError(request, err);
  }
}
