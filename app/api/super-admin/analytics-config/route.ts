import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import {
  getAnalyticsConfig, setSetting, DEFAULT_ANALYTICS_CONFIG,
  isMeasurementId, isContainerId, AnalyticsConfig,
} from '@/lib/app-settings';
import { apiError } from '@/lib/api-response';

// =====================================================================================
// 🛡️ ADMIN — GOOGLE ANALYTICS CONFIG
// GET -> the current config
// PUT -> replace it
//
// Admin-only via middleware.ts (all /api/super-admin/* requires role === 'admin').
// Stored in app_settings.analytics_config. Public read is a separate route,
// /api/app/analytics-config, which the client reads on every load.
// =====================================================================================

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  try {
    const config = await getAnalyticsConfig();
    return NextResponse.json({ success: true, data: config }, {
      status: 200, headers: { 'Cache-Control': 'no-store' },
    });
  } catch (err) {
    return apiError(request, err);
  }
}

export async function PUT(request: NextRequest) {
  try {
    const body = await request.json();

    // Uppercased before validation so a pasted lowercase id isn't rejected for a typo the
    // admin can't see. Trimmed because copying from the GA console brings whitespace.
    const gaMeasurementId = String(body.gaMeasurementId || '').trim().toUpperCase();
    const gtmContainerId = String(body.gtmContainerId || '').trim().toUpperCase();

    // Empty is always allowed — that is how you turn one of them off.
    if (gaMeasurementId && !isMeasurementId(gaMeasurementId)) {
      return NextResponse.json({
        success: false,
        error: 'That is not a valid GA4 measurement ID. It looks like "G-XXXXXXXXXX".',
      }, { status: 400 });
    }
    if (gtmContainerId && !isContainerId(gtmContainerId)) {
      return NextResponse.json({
        success: false,
        error: 'That is not a valid Tag Manager container ID. It looks like "GTM-XXXXXXX".',
      }, { status: 400 });
    }

    const enabledWeb = !!body.enabledWeb;
    const enabledApp = !!body.enabledApp;

    // Refuse to "enable" nothing — otherwise the admin flips the switch, sees it stay on,
    // and assumes tracking is live when no tag will ever load.
    if ((enabledWeb || enabledApp) && !gaMeasurementId && !gtmContainerId) {
      return NextResponse.json({
        success: false,
        error: 'Add a measurement ID or a container ID before enabling analytics.',
      }, { status: 400 });
    }

    const config: AnalyticsConfig = { ...DEFAULT_ANALYTICS_CONFIG, gaMeasurementId, gtmContainerId, enabledWeb, enabledApp };
    await setSetting('analytics_config', config);

    return NextResponse.json({ success: true, data: config, message: 'Analytics settings saved.' }, { status: 200 });
  } catch (err) {
    return apiError(request, err);
  }
}
