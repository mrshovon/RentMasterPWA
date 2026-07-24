import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { getMaintenanceMode, setSetting, type MaintenanceMode } from '@/lib/app-settings';

// =====================================================================================
// 🛠 MAINTENANCE MODE — ADMIN
// GET   -> the current window.
// PATCH -> { enabled, startAt, endAt, message } (all optional; merged over what's stored).
//
// Admin-only via the /api/super-admin/* gate in middleware.ts. The public read for the
// client-side gate lives at /api/app/maintenance.
// =====================================================================================

function parseWhen(value: unknown, field: string): string | null {
  if (value === null || value === undefined || value === '') return null;
  const d = new Date(String(value));
  if (Number.isNaN(d.getTime())) throw new Error(`${field} is not a valid date/time.`);
  return d.toISOString();
}

export async function GET() {
  try {
    const data = await getMaintenanceMode();
    return NextResponse.json({ success: true, data }, { status: 200 });
  } catch (err: any) {
    console.error('Maintenance GET error:', err);
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const body = await request.json();
    const current = await getMaintenanceMode();

    const next: MaintenanceMode = {
      enabled: body.enabled === undefined ? current.enabled : !!body.enabled,
      startAt: body.startAt === undefined ? current.startAt : parseWhen(body.startAt, 'Start time'),
      endAt: body.endAt === undefined ? current.endAt : parseWhen(body.endAt, 'End time'),
      message: body.message === undefined ? current.message : String(body.message).slice(0, 1000),
    };

    if (next.startAt && next.endAt && new Date(next.endAt) <= new Date(next.startAt)) {
      return NextResponse.json(
        { success: false, error: 'The end time must be after the start time.' },
        { status: 400 }
      );
    }

    await setSetting('maintenance_mode', next);
    return NextResponse.json({ success: true, data: next }, { status: 200 });
  } catch (err: any) {
    console.error('Maintenance PATCH error:', err);
    return NextResponse.json({ success: false, error: err.message }, { status: 400 });
  }
}
