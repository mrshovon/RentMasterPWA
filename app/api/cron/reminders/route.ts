import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { supabaseAdminEngine } from '@/lib/supabase-server';
import { deliverReminder, type ReminderRow } from '@/lib/reminders';

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
    console.error('[cron/reminders] query failed:', error);
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }

  let reminders = 0;
  let notified = 0;
  for (const r of due || []) {
    try {
      notified += await deliverReminder(r as ReminderRow);
      reminders++;
    } catch (e) {
      console.error('[cron/reminders] delivery failed for', r.id, e);
    }
  }

  return NextResponse.json({ success: true, reminders, notified }, { status: 200 });
}

// Vercel Cron issues a GET; POST supported for manual triggering.
export async function GET(request: NextRequest) { return run(request); }
export async function POST(request: NextRequest) { return run(request); }
