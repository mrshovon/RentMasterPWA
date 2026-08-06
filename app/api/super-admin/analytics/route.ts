import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { supabaseAdminEngine } from '@/lib/supabase-server';
import { getOnlineBreakdown, countActiveUsers } from '@/lib/presence';

// =====================================================================================
// 📊 ADMIN — ANALYTICS
// GET ?from=YYYY-MM-DD&to=YYYY-MM-DD -> platform totals, who is online, active users and a
// per-day new-user series, plus the same figures for the immediately preceding period of
// equal length so the UI can show a change.
//
// "New users" means signups (owners from auth.users, tenants from tenants.created_at).
// There is no anonymous-visitor tracking anywhere in the system and this route invents
// none — a true visitor count is what Google Analytics is being wired up for separately.
// =====================================================================================

export const dynamic = 'force-dynamic';

const DAY_MS = 24 * 60 * 60 * 1000;

// Bucket ISO timestamps into YYYY-MM-DD counts, seeded with a zero for every day in the
// range so the chart has no gaps.
function seriesFrom(timestamps: string[], from: Date, to: Date): { date: string; count: number }[] {
  const buckets: Record<string, number> = {};
  for (let t = Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate());
       t <= to.getTime(); t += DAY_MS) {
    buckets[new Date(t).toISOString().slice(0, 10)] = 0;
  }
  for (const ts of timestamps) {
    const key = String(ts).slice(0, 10);
    if (key in buckets) buckets[key] += 1;
  }
  return Object.entries(buckets)
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([date, count]) => ({ date, count }));
}

const inRange = (ts: string | null | undefined, from: Date, to: Date) => {
  if (!ts) return false;
  const t = new Date(ts).getTime();
  return t >= from.getTime() && t <= to.getTime();
};

export async function GET(request: NextRequest) {
  try {
    const params = request.nextUrl.searchParams;

    // Default window: the last 30 days, inclusive of today.
    const to = params.get('to') ? new Date(`${params.get('to')}T23:59:59.999Z`) : new Date();
    const from = params.get('from')
      ? new Date(`${params.get('from')}T00:00:00.000Z`)
      : new Date(to.getTime() - 29 * DAY_MS);

    if (isNaN(from.getTime()) || isNaN(to.getTime()) || from > to) {
      return NextResponse.json({ success: false, error: 'Invalid date range.' }, { status: 400 });
    }

    // The immediately preceding window of the same length, for the comparison figures.
    const spanMs = to.getTime() - from.getTime();
    const prevTo = new Date(from.getTime() - 1);
    const prevFrom = new Date(prevTo.getTime() - spanMs);

    // --- accounts -----------------------------------------------------------------------
    const { data: userList, error: userErr } = await supabaseAdminEngine.auth.admin.listUsers({ page: 1, perPage: 1000 });
    if (userErr) throw userErr;
    const users = userList?.users || [];
    const owners = users.filter((u) => ((u.user_metadata as any)?.role || 'owner') !== 'admin');
    const admins = users.filter((u) => ((u.user_metadata as any)?.role) === 'admin');

    const { data: tenantRows, error: tenantErr } = await supabaseAdminEngine
      .from('tenants').select('id, created_at');
    if (tenantErr) throw tenantErr;
    const tenants = tenantRows || [];

    // --- new users in each window --------------------------------------------------------
    const ownerSignups = owners.map((u) => u.created_at).filter((t) => inRange(t, from, to));
    const tenantSignups = tenants.map((t) => t.created_at).filter((t) => inRange(t, from, to));
    const prevOwnerSignups = owners.filter((u) => inRange(u.created_at, prevFrom, prevTo)).length;
    const prevTenantSignups = tenants.filter((t) => inRange(t.created_at, prevFrom, prevTo)).length;

    // --- presence -------------------------------------------------------------------------
    const [onlineNow, active, prevActive] = await Promise.all([
      getOnlineBreakdown(),
      countActiveUsers(from.toISOString(), to.toISOString()),
      countActiveUsers(prevFrom.toISOString(), prevTo.toISOString()),
    ]);

    return NextResponse.json({
      success: true,
      range: { from: from.toISOString(), to: to.toISOString() },
      previousRange: { from: prevFrom.toISOString(), to: prevTo.toISOString() },
      totals: {
        owners: owners.length,
        admins: admins.length,
        tenants: tenants.length,
        allUsers: owners.length + admins.length + tenants.length,
      },
      onlineNow,
      activeUsers: { current: active.total, previous: prevActive.total, byRole: active.byRole },
      newUsers: {
        owners: ownerSignups.length,
        tenants: tenantSignups.length,
        total: ownerSignups.length + tenantSignups.length,
        previousTotal: prevOwnerSignups + prevTenantSignups,
        ownerSeries: seriesFrom(ownerSignups, from, to),
        tenantSeries: seriesFrom(tenantSignups, from, to),
      },
    }, { status: 200, headers: { 'Cache-Control': 'no-store' } });
  } catch (err: any) {
    console.error('Admin Analytics GET error:', err);
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}
