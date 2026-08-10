import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { supabaseAdminEngine } from '@/lib/supabase-server';
import { deliverReminder, type ReminderRow } from '@/lib/reminders';
import { apiError } from '@/lib/api-response';
import { logEvent, describeError } from '@/lib/logger';

// =====================================================================================
// CRON — deliver due rent reminders. Public path (middleware only gates /api/admin,
// /api/super-admin, /api/notifications), so this route protects ITSELF with CRON_SECRET.
// Vercel Cron sends `Authorization: Bearer <CRON_SECRET>` automatically when the env var
// is set. Runs daily (see vercel.json): send every pending reminder whose date has arrived.
// =====================================================================================

const todayStr = () => new Date().toISOString().slice(0, 10);

function authorized(request: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false; // fail closed: no secret configured => no delivery
  const auth = request.headers.get('authorization');
  if (auth === `Bearer ${secret}`) return true;
  // Fallback for manual/external triggers: ?secret=...
  if (request.nextUrl.searchParams.get('secret') === secret) return true;
  return false;
}

async function run(request: NextRequest) {
  if (!authorized(request)) {
    return NextResponse.json({ success: false, error: 'Unauthorized.' }, { status: 401 });
  }

  const { data: due, error } = await supabaseAdminEngine
    .from('reminders')
    .select('*')
    .eq('status', 'pending')
    .lte('scheduled_date', todayStr());
  if (error) {
    return apiError(request, error, { source: 'cron' });
  }

  let reminders = 0;
  let notified = 0;
  for (const r of due || []) {
    try {
      notified += await deliverReminder(r as ReminderRow);
      reminders++;
    } catch (e) {
      // One tenant's failed delivery must not abandon the rest of the run, so this is caught and
      // recorded rather than thrown. Logged to app_logs as well as the console: a cron failure
      // happens at 06:00 with nobody watching, which is exactly the case runtime logs lose.
      await logEvent({
        source: 'cron',
        message: `Reminder delivery failed for ${r.id}`,
        detail: describeError(e).detail,
        route: '/api/cron/reminders',
        context: { reminderId: r.id },
      });
    }
  }

  return NextResponse.json({ success: true, reminders, notified }, { status: 200 });
}

// Vercel Cron issues a GET; POST supported for manual triggering.
export async function GET(request: NextRequest) { return run(request); }
export async function POST(request: NextRequest) { return run(request); }
