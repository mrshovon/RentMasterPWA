import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { supabaseAdminEngine } from '@/lib/supabase-server';
import { sendPushToUsers } from '@/lib/push-send';
import crypto from 'crypto';

// =====================================================================================
// 👋 ADMIN — WELCOME NEW USERS
// GET  ?audience=&days=  -> DRY RUN: how many people this would reach, and who.
// POST { title, content, audience, days } -> send it.
//
// Manual by design (the admin sends it when they choose) — there is no cron for this.
//
// Delivery is an in-app notice PLUS a push, so it survives a device with notifications
// switched off. Every send is recorded in welcome_dispatch, which is what makes
// "never welcomed" a selectable audience and makes a re-send safe: already-welcomed
// people are skipped rather than pestered twice.
// =====================================================================================

const AUDIENCES = ['new_owners', 'new_tenants', 'both'] as const;
type Audience = (typeof AUDIENCES)[number];

// PostgREST's codes for "table/column not in the schema cache" — i.e. ADD_PRESENCE.sql
// (which creates welcome_dispatch) has not been run. Postgres's own codes are included
// because the two layers report this differently.
const MISSING_TABLE_CODES = ['PGRST205', '42P01'];
const isMissingTable = (code?: string) => MISSING_TABLE_CODES.includes(code || '');

// A single dispatch is capped so one click can't fan out unboundedly.
const MAX_RECIPIENTS = 500;

interface Recipient {
  id: string;
  role: 'owner' | 'tenant';
  name: string | null;
  joinedAt: string;
}

/** Everyone already welcomed. Empty set (and a warning) if the table isn't there yet. */
async function alreadyWelcomed(): Promise<{ ids: Set<string>; migrated: boolean }> {
  const { data, error } = await supabaseAdminEngine.from('welcome_dispatch').select('user_id');
  if (error) {
    if (isMissingTable(error.code)) {
      console.warn('[welcome] welcome_dispatch is missing — run ADD_PRESENCE.sql. Cannot skip already-welcomed users.');
      return { ids: new Set(), migrated: false };
    }
    throw error;
  }
  return { ids: new Set((data || []).map((r: { user_id: string }) => r.user_id)), migrated: true };
}

/**
 * Resolve who a send would reach.
 *
 * `days > 0` limits to accounts created in that window; `days = 0` means "everyone who has
 * never been welcomed, however old". Already-welcomed users are always excluded — that is
 * the whole point of the dedupe log.
 */
async function resolveRecipients(audience: Audience, days: number): Promise<{ recipients: Recipient[]; migrated: boolean }> {
  const since = days > 0 ? Date.now() - days * 24 * 60 * 60 * 1000 : null;
  const { ids: welcomed, migrated } = await alreadyWelcomed();
  const recipients: Recipient[] = [];

  if (audience === 'new_owners' || audience === 'both') {
    const { data: list, error } = await supabaseAdminEngine.auth.admin.listUsers({ page: 1, perPage: 1000 });
    if (error) throw error;
    for (const u of list?.users || []) {
      // Admins are staff, not new users to welcome.
      if (((u.user_metadata as any)?.role) === 'admin') continue;
      if (welcomed.has(u.id)) continue;
      if (since && new Date(u.created_at).getTime() < since) continue;
      recipients.push({ id: u.id, role: 'owner', name: (u.user_metadata as any)?.name || u.email || null, joinedAt: u.created_at });
    }
  }

  if (audience === 'new_tenants' || audience === 'both') {
    const { data: rows, error } = await supabaseAdminEngine.from('tenants').select('id, name, created_at');
    if (error) throw error;
    for (const t of rows || []) {
      if (welcomed.has(t.id)) continue;
      if (since && new Date(t.created_at).getTime() < since) continue;
      recipients.push({ id: t.id, role: 'tenant', name: t.name || null, joinedAt: t.created_at });
    }
  }

  // Newest first, so a capped send covers the most recent joiners.
  recipients.sort((a, b) => (a.joinedAt < b.joinedAt ? 1 : -1));
  return { recipients, migrated };
}

function parseQuery(request: NextRequest) {
  const p = request.nextUrl.searchParams;
  const audience = (AUDIENCES as readonly string[]).includes(p.get('audience') || '')
    ? (p.get('audience') as Audience) : 'both';
  const days = Math.max(0, Math.min(365, parseInt(p.get('days') || '7', 10) || 0));
  return { audience, days };
}

// ---------------------------------------------------------------------------------------
// GET — dry run. Never sends anything.
// ---------------------------------------------------------------------------------------
export async function GET(request: NextRequest) {
  try {
    const { audience, days } = parseQuery(request);
    const { recipients, migrated } = await resolveRecipients(audience, days);
    return NextResponse.json({
      success: true,
      audience,
      days,
      count: recipients.length,
      capped: recipients.length > MAX_RECIPIENTS,
      maxPerSend: MAX_RECIPIENTS,
      dedupeAvailable: migrated,
      // A short sample so the admin can sanity-check WHO before sending, without shipping
      // the whole directory to the browser.
      sample: recipients.slice(0, 5).map((r) => ({ name: r.name, role: r.role, joinedAt: r.joinedAt })),
    }, { status: 200, headers: { 'Cache-Control': 'no-store' } });
  } catch (err: any) {
    console.error('Admin welcome GET error:', err);
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}

// ---------------------------------------------------------------------------------------
// POST — actually send.
// ---------------------------------------------------------------------------------------
export async function POST(request: NextRequest) {
  try {
    const adminId = request.headers.get('x-rentmaster-uid');
    const body = await request.json();

    const title = String(body.title || '').trim();
    const content = String(body.content || '').trim();
    if (!title || !content) {
      return NextResponse.json({ success: false, error: 'A title and a message are both required.' }, { status: 400 });
    }

    const audience: Audience = (AUDIENCES as readonly string[]).includes(body.audience) ? body.audience : 'both';
    const days = Math.max(0, Math.min(365, parseInt(body.days ?? '7', 10) || 0));

    const { recipients } = await resolveRecipients(audience, days);
    if (!recipients.length) {
      return NextResponse.json({
        success: false,
        error: 'Nobody matches that audience — everyone in it has already been welcomed.',
      }, { status: 409 });
    }

    const batch = recipients.slice(0, MAX_RECIPIENTS);

    // 1. The notices. One targeted row each, matching the shape /api/admin/notices writes.
    const noticeRows = batch.map((r) => ({
      id: crypto.randomUUID(),
      sender_type: 'system_admin',
      sender_id: adminId,
      target_scope: r.role === 'owner' ? 'individual_owner' : 'individual_tenant',
      target_owner_id: r.role === 'owner' ? r.id : null,
      target_tenant_id: r.role === 'tenant' ? r.id : null,
      title,
      content,
    }));

    const { error: noticeErr } = await supabaseAdminEngine.from('notices').insert(noticeRows);
    if (noticeErr) throw noticeErr;

    // 2. The dedupe log. Best-effort: if this fails the notices are already delivered, and
    // refusing to report a successful send would be worse than a possible duplicate later.
    const { error: logErr } = await supabaseAdminEngine.from('welcome_dispatch').upsert(
      batch.map((r, i) => ({
        user_id: r.id,
        role: r.role,
        notice_id: noticeRows[i].id,
        sent_at: new Date().toISOString(),
      })),
      { onConflict: 'user_id' }
    );
    if (logErr) {
      console.error('[welcome] could not record welcome_dispatch — a re-send may duplicate:', logErr.message);
    }

    // 3. Push, fire-and-forget. Same posture as /api/admin/notices: a push failure must
    // never fail a send whose notices are already written.
    try {
      const ownerIds = batch.filter((r) => r.role === 'owner').map((r) => r.id);
      const tenantIds = batch.filter((r) => r.role === 'tenant').map((r) => r.id);
      const payload = { title, body: content.slice(0, 180), tag: `welcome-${Date.now()}` };
      if (ownerIds.length) await sendPushToUsers(ownerIds, { ...payload, url: '/owner' });
      if (tenantIds.length) await sendPushToUsers(tenantIds, { ...payload, url: '/tenant' });
    } catch (pushErr) {
      console.error('[welcome] push dispatch failed (non-fatal):', pushErr);
    }

    return NextResponse.json({
      success: true,
      sent: batch.length,
      remaining: recipients.length - batch.length,
      message: `Welcome message sent to ${batch.length} user${batch.length === 1 ? '' : 's'}.`
        + (recipients.length > batch.length
          ? ` ${recipients.length - batch.length} more matched — send again to continue.` : ''),
    }, { status: 201 });
  } catch (err: any) {
    console.error('Admin welcome POST error:', err);
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}
