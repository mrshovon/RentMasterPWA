import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { supabaseAdminEngine } from '@/lib/supabase-server';
import { apiError } from '@/lib/api-response';

// =====================================================================================
// 📓 APPLICATION LOG — ADMIN-ONLY VIEW
//
// GET    -> filtered, keyset-paginated log rows, newest first.
// DELETE -> purge rows older than N days.
//
// middleware.ts already 403s any caller whose role is not 'admin' on /api/super-admin/*, so there
// is no auth code here. This is the ONLY read surface for app_logs (the table is RLS deny-all).
//
// TWO DELIBERATE DEPARTURES from the other admin list routes:
//
//   1. Real server-side filtering and pagination. Every other admin endpoint selects the whole
//      table and filters in the browser, which is fine for a few hundred owners and wrong for a
//      log that gains rows every time anything fails.
//
//   2. No `auth.admin.listUsers({ perPage: 1000 })` enrichment pass. Logs already snapshot
//      `user_email` at write time, so there is nothing to join — and that 1000 cap is the de-facto
//      ceiling on the rest of the admin console, which is not a thing to reproduce here.
//
// Paging is keyset (`?before=<created_at>`), not offset. A log table grows at its head while you
// are reading it, so OFFSET 100 would silently skip or repeat rows between pages; "older than the
// last row I saw" cannot.
// =====================================================================================

export const dynamic = 'force-dynamic';

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

const LEVELS = ['error', 'warn', 'info'];
const SOURCES = ['api', 'client', 'cron', 'email', 'push'];

export async function GET(request: NextRequest) {
  try {
    const p = request.nextUrl.searchParams;

    const limit = Math.min(MAX_LIMIT, Math.max(1, parseInt(p.get('limit') || '', 10) || DEFAULT_LIMIT));
    const level = p.get('level');
    const source = p.get('source');
    const search = (p.get('q') || '').trim();
    const from = p.get('from');
    const to = p.get('to');
    const before = p.get('before');
    const requestId = p.get('request_id');
    const userId = p.get('user_id');

    let query = supabaseAdminEngine
      .from('app_logs')
      .select('*')
      .order('created_at', { ascending: false })
      // One extra row than asked for: its presence is how the client knows a "Load older" button
      // is worth showing, without a second count query.
      .limit(limit + 1);

    if (level && LEVELS.includes(level)) query = query.eq('level', level);
    if (source && SOURCES.includes(source)) query = query.eq('source', source);
    if (requestId) query = query.eq('request_id', requestId);
    if (userId) query = query.eq('user_id', userId);
    if (from) query = query.gte('created_at', from);
    if (to) query = query.lte('created_at', to);
    if (before) query = query.lt('created_at', before);

    if (search) {
      // Commas and parentheses are PostgREST's `or()` separators — a search string containing one
      // would otherwise be parsed as extra filter terms rather than as text to look for.
      const safe = search.replace(/[,()]/g, ' ');
      query = query.or(
        `message.ilike.%${safe}%,route.ilike.%${safe}%,user_email.ilike.%${safe}%,code.ilike.%${safe}%,request_id.ilike.%${safe}%`,
      );
    }

    const { data, error } = await query;
    if (error) throw error;

    const rows = data || [];
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;

    return NextResponse.json(
      {
        success: true,
        count: page.length,
        hasMore,
        // The cursor for the next page. Null when this is the end.
        nextBefore: hasMore ? page[page.length - 1].created_at : null,
        data: page,
      },
      { status: 200, headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (err) {
    return apiError(request, err);
  }
}

/**
 * Manual purge. The subscriptions cron does this on a schedule too (30 days); this is the button
 * for when something has just written a great deal of noise and the admin wants it gone now.
 */
export async function DELETE(request: NextRequest) {
  try {
    const days = Math.max(1, parseInt(request.nextUrl.searchParams.get('olderThanDays') || '', 10) || 30);
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

    const { error, count } = await supabaseAdminEngine
      .from('app_logs')
      .delete({ count: 'exact' })
      .lt('created_at', cutoff);
    if (error) throw error;

    return NextResponse.json(
      { success: true, deleted: count || 0, message: `Removed ${count || 0} log entries older than ${days} days.` },
      { status: 200 },
    );
  } catch (err) {
    return apiError(request, err);
  }
}
