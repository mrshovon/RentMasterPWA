import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import {
  getUddoktaPayConfig,
  setUddoktaPayConfig,
  DEFAULT_UDDOKTAPAY_CONFIG,
  type UddoktaPayConfig,
} from '@/lib/app-settings';
import { decryptField, hasEncryptionKey } from '@/lib/field-crypto';
import { activeCredentials, verifyPayment, UddoktaPayError } from '@/lib/payments/uddoktapay';
import { apiError } from '@/lib/api-response';

// =====================================================================================
// UDDOKTAPAY CONFIG — SUPER ADMIN ONLY
// GET  -> the config with the keys MASKED.
// PUT  -> save it. An empty key field means "keep the stored one".
// POST -> a connectivity test against the selected mode.
//
// No auth code here on purpose: middleware.ts gates every /api/super-admin/* path on
// user_metadata.role === 'admin' and returns 403 before a handler ever runs.
//
// ⭐ THE KEYS NEVER COME BACK. Every other settings route in this app round-trips its values to
// the browser and back, which is fine for a wallet number or a GA measurement id. An UddoktaPay
// key can take money and issue refunds on this account, so the read path returns a masked
// `abcd…wxyz` plus a boolean, and there is no route anywhere that will hand over the real value.
// That is also why an empty field on save means "unchanged" rather than "clear": the form cannot
// show what it does not receive, so it must be able to save the mode or a base URL without
// re-typing a key.
//
// There is deliberately NO public counterpart to this route (compare /api/app/analytics-config).
// =====================================================================================

/** `abcd…wxyz` — enough to tell two keys apart, not enough to be one. */
function preview(key: string | null): string {
  if (!key) return '';
  if (key.length <= 12) return '••••';
  return `${key.slice(0, 4)}…${key.slice(-4)}`;
}

function publicShape(cfg: UddoktaPayConfig) {
  const sandboxKey = decryptField(cfg.sandboxApiKeyEnc);
  const liveKey = decryptField(cfg.liveApiKeyEnc);
  return {
    mode: cfg.mode,
    sandboxBaseUrl: cfg.sandboxBaseUrl,
    liveBaseUrl: cfg.liveBaseUrl,
    hasSandboxKey: !!sandboxKey,
    sandboxKeyPreview: preview(sandboxKey),
    hasLiveKey: !!liveKey,
    liveKeyPreview: preview(liveKey),
    // Surfaced so the form can say WHY a stored key is unusable instead of silently showing
    // "not configured" — a rotated or missing FIELD_ENCRYPTION_KEY looks identical otherwise.
    encryptionReady: hasEncryptionKey(),
    // Whether the mode currently selected could actually take a payment right now.
    activeReady: !!activeCredentials(cfg),
  };
}

export async function GET(request: Request) {
  try {
    return NextResponse.json({ success: true, data: publicShape(await getUddoktaPayConfig()) }, { status: 200 });
  } catch (err) {
    return apiError(request, err);
  }
}

export async function PUT(request: NextRequest) {
  try {
    const body = await request.json();

    const mode: 'sandbox' | 'live' = body.mode === 'live' ? 'live' : 'sandbox';
    const sandboxBaseUrl = String(body.sandboxBaseUrl ?? DEFAULT_UDDOKTAPAY_CONFIG.sandboxBaseUrl).trim();
    const liveBaseUrl = String(body.liveBaseUrl ?? '').trim();

    // Both are sent to a fetch(), so a typo'd scheme becomes a confusing runtime failure much
    // later. Reject it while someone is looking at the field.
    for (const [label, url] of [['Sandbox', sandboxBaseUrl], ['Live', liveBaseUrl]] as const) {
      if (url && !/^https?:\/\/.+/i.test(url)) {
        return NextResponse.json(
          { success: false, error: `The ${label} base URL must start with http:// or https://` },
          { status: 400 },
        );
      }
    }

    const sandboxApiKey = typeof body.sandboxApiKey === 'string' ? body.sandboxApiKey.trim() : '';
    const liveApiKey = typeof body.liveApiKey === 'string' ? body.liveApiKey.trim() : '';

    // Refuse to store a key we cannot encrypt, rather than storing nothing and reporting success.
    if ((sandboxApiKey || liveApiKey) && !hasEncryptionKey()) {
      return NextResponse.json(
        {
          success: false,
          error:
            'FIELD_ENCRYPTION_KEY is not configured on the server, so the API key cannot be stored securely. Set it before connecting UddoktaPay.',
        },
        { status: 400 },
      );
    }

    // Switching to live with nothing behind it is the one mistake here that costs real money —
    // an owner reaches a checkout that cannot be created. Block it at the point of the decision.
    const current = await getUddoktaPayConfig();
    const willHaveLiveKey = !!(liveApiKey || decryptField(current.liveApiKeyEnc));
    if (mode === 'live' && (!liveBaseUrl || !willHaveLiveKey)) {
      return NextResponse.json(
        { success: false, error: 'Add the live base URL and API key before switching to live mode.' },
        { status: 400 },
      );
    }

    await setUddoktaPayConfig({ mode, sandboxBaseUrl, liveBaseUrl }, { sandboxApiKey, liveApiKey });

    return NextResponse.json({ success: true, data: publicShape(await getUddoktaPayConfig()) }, { status: 200 });
  } catch (err) {
    return apiError(request, err);
  }
}

/**
 * Connectivity test. Mirrors the Brevo test-send: saving a key proves nothing about whether it
 * works, and finding that out for the first time when a customer is mid-purchase is the wrong
 * moment.
 *
 * ⚠️ IT ASKS ABOUT A BOGUS INVOICE AND READS THE MESSAGE, NOT THE STATUS.
 * verify-payment answers HTTP 200 for everything, including auth failures (see the note on
 * verifyPayment in lib/payments/uddoktapay.ts). The three outcomes are told apart by their text:
 *
 *   "No Data Found"     -> the key was ACCEPTED, the invoice simply does not exist. PASS.
 *   "Api Do Not Match"  -> the key was rejected. FAIL.
 *   "Api Not Found"     -> no key reached the gateway. FAIL.
 *
 * A naive version of this reported "Connected" for a wrong key, which is worse than having no
 * test at all. No money moves either way.
 */
const KEY_REJECTED = /api\s*(do\s*not\s*match|not\s*found)/i;

export async function POST(request: NextRequest) {
  try {
    const credentials = activeCredentials(await getUddoktaPayConfig());
    if (!credentials) {
      return NextResponse.json(
        { success: false, error: 'Add a base URL and API key for the selected mode first.' },
        { status: 400 },
      );
    }

    try {
      await verifyPayment('bari360-connectivity-check', credentials);
      // A real record for an id we invented would be bizarre, but it still proves reachability.
      return NextResponse.json(
        { success: true, data: { message: `Connected to ${credentials.baseUrl} (${credentials.mode}).` } },
        { status: 200 },
      );
    } catch (err) {
      if (err instanceof UddoktaPayError) {
        const gatewayMessage = String((err.detail as any)?.message || err.message);

        if (KEY_REJECTED.test(gatewayMessage)) {
          return NextResponse.json(
            {
              success: false,
              error: `The gateway rejected the ${credentials.mode} API key ("${gatewayMessage}"). Check the key and the base URL.`,
            },
            { status: 400 },
          );
        }

        // Reached it, and it accepted our key well enough to look the invoice up and not find it.
        // That is exactly the pass condition.
        return NextResponse.json(
          {
            success: true,
            data: {
              message: `Connected to ${credentials.baseUrl} (${credentials.mode}) — the API key was accepted.`,
            },
          },
          { status: 200 },
        );
      }
      throw err;
    }
  } catch (err) {
    return apiError(request, err);
  }
}
