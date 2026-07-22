import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { sendPushReport, isWebPushConfigured } from '@/lib/push-send';

// =====================================================================================
// 🔔 PUSH SELF-TEST
// POST -> sends a test notification to the CALLER'S OWN devices and reports what happened
//         per token. Identity comes from the middleware-injected headers, exactly like
//         /api/notifications/register, so a caller can only ever test themselves.
//
// This exists because push failures are invisible from a phone: a missing VAPID key or a
// misrouted transport both look identical to "nothing happened". The report names the
// cause instead. Endpoints are reported by HOST only — a full Web Push endpoint is
// bearer-grade and must not be echoed back.
// =====================================================================================
export async function POST(request: NextRequest) {
  try {
    const userId =
      request.headers.get('x-rentmaster-uid') || request.headers.get('x-rentmaster-tenant-id');
    if (!userId) {
      return NextResponse.json({ success: false, error: 'Unauthorized.' }, { status: 401 });
    }

    const report = await sendPushReport([userId], {
      title: 'RentMaster test notification',
      body: 'If you can see this, notifications are working on this device.',
      url: '/',
      tag: 'push-self-test',
    });

    const delivered = report.attempts.filter((a) => a.ok).length;

    // Name the most likely cause so the UI can say something better than "it failed".
    let hint: string | null = null;
    if (!report.configured) {
      hint = 'The server has no VAPID keys — set NEXT_PUBLIC_VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY on the backend and redeploy.';
    } else if (report.tokens === 0) {
      hint = 'This device is not registered for notifications. Enable them, then try again.';
    } else if (delivered === 0) {
      const first = report.attempts.find((a) => !a.ok)?.error || '';
      hint = first.includes('403')
        ? 'The push service rejected the request — the backend VAPID public key probably does not match the one the browser subscribed with.'
        : `No device accepted the notification: ${first}`;
    }

    return NextResponse.json({
      success: delivered > 0,
      configured: report.configured,
      tokens: report.tokens,
      delivered,
      attempts: report.attempts,
      hint,
    }, { status: 200 });
  } catch (err: any) {
    console.error('[push] self-test failed:', err);
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}

/** Config-only probe — no notification sent. Useful for checking a deployment quickly. */
export async function GET() {
  return NextResponse.json({ success: true, configured: isWebPushConfigured() }, { status: 200 });
}
