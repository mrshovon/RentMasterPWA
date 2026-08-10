import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { getBrevoConfig, setSetting, DEFAULT_BREVO_CONFIG, type BrevoConfig } from '@/lib/app-settings';
import { encryptField, decryptField, hasEncryptionKey } from '@/lib/field-crypto';
import { validateEmail } from '@/lib/validate';
import { sendEmail } from '@/lib/email/brevo';
import { apiError } from '@/lib/api-response';

// =====================================================================================
// 🛡️ ADMIN — BREVO EMAIL CONFIG
// GET  -> the settings, WITHOUT the API key (a preview and a boolean instead)
// PUT  -> save; an empty apiKey means "keep the one already stored"
// POST -> send a test email to prove the account actually works
//
// middleware.ts already 403s any caller whose role is not 'admin' on /api/super-admin/*.
//
// THE KEY NEVER COMES BACK. Every other settings route in this app round-trips its values to the
// browser and back, which is fine for a wallet number or a GA measurement id. A Brevo API key can
// send mail as this company, so the read path returns `xkeysib-…4f2a` and `hasApiKey: true` and
// there is no route anywhere that will hand over the real value. That is also why an empty field
// on save means "unchanged" rather than "clear": the form cannot show what it does not receive,
// so it must be able to save the other fields without re-typing the key.
//
// There is deliberately NO public counterpart to this route (compare /api/app/analytics-config).
// Nothing in the browser has any business knowing this configuration exists.
// =====================================================================================

export const dynamic = 'force-dynamic';

/** `xkeysib-…4f2a` — enough to tell two keys apart, not enough to be one. */
function preview(key: string | null): string {
  if (!key) return '';
  const head = key.slice(0, 8);
  const tail = key.slice(-4);
  return `${head}…${tail}`;
}

function publicShape(cfg: BrevoConfig) {
  const key = decryptField(cfg.apiKeyEnc);
  return {
    enabled: cfg.enabled,
    senderEmail: cfg.senderEmail,
    senderName: cfg.senderName,
    replyTo: cfg.replyTo,
    hasApiKey: !!key,
    apiKeyPreview: preview(key),
    // Surfaced so the form can say WHY a stored key is unusable instead of silently showing
    // "not configured" — a rotated or missing NID_ENCRYPTION_KEY looks identical otherwise.
    encryptionReady: hasEncryptionKey(),
  };
}

export async function GET(request: NextRequest) {
  try {
    const cfg = await getBrevoConfig();
    return NextResponse.json(
      { success: true, data: publicShape(cfg) },
      { status: 200, headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (err) {
    return apiError(request, err);
  }
}

export async function PUT(request: NextRequest) {
  try {
    const body = await request.json();
    const current = await getBrevoConfig();

    const senderEmail = String(body.senderEmail ?? '').trim().toLowerCase();
    const senderName = String(body.senderName ?? '').trim();
    const replyTo = String(body.replyTo ?? '').trim().toLowerCase();
    const apiKeyRaw = String(body.apiKey ?? '').trim();
    const enabled = !!body.enabled;

    if (senderEmail) {
      const parsed = validateEmail(senderEmail, { required: true });
      if (!parsed.ok) {
        return NextResponse.json({ success: false, error: `Sender email: ${parsed.error}` }, { status: 400 });
      }
    }
    if (replyTo) {
      const parsed = validateEmail(replyTo, { required: true });
      if (!parsed.ok) {
        return NextResponse.json({ success: false, error: `Reply-to email: ${parsed.error}` }, { status: 400 });
      }
    }

    // Empty means unchanged — see the header note.
    let apiKeyEnc = current.apiKeyEnc;
    if (apiKeyRaw) {
      if (!hasEncryptionKey()) {
        return NextResponse.json(
          {
            success: false,
            error: 'NID_ENCRYPTION_KEY is not configured on the server, so the API key cannot be stored securely. Set it before connecting Brevo.',
          },
          { status: 400 },
        );
      }
      // Fail loudly rather than storing nothing while reporting success — the same rule the
      // tenant NID write follows.
      apiKeyEnc = encryptField(apiKeyRaw);
    }

    // Refusing this is the difference between "email is on" and "email silently does nothing",
    // which is exactly the failure mode the analytics route already guards against.
    if (enabled && (!apiKeyEnc || !senderEmail)) {
      return NextResponse.json(
        { success: false, error: 'Add an API key and a verified sender email before switching Brevo on.' },
        { status: 400 },
      );
    }

    const next: BrevoConfig = {
      ...DEFAULT_BREVO_CONFIG,
      enabled,
      apiKeyEnc,
      senderEmail,
      senderName: senderName || 'Bari360',
      replyTo,
    };
    await setSetting('brevo_config', next);

    return NextResponse.json(
      {
        success: true,
        data: publicShape(next),
        message: enabled ? 'Brevo connected. Emails will now be sent through it.' : 'Brevo settings saved (currently off).',
      },
      { status: 200 },
    );
  } catch (err) {
    return apiError(request, err);
  }
}

/**
 * Send a test message. The only way to find out whether the sender address is actually verified
 * on the Brevo account — an unverified sender is accepted by the form and rejected by the API,
 * and without this the first person to discover that would be a user who never got their reset
 * link.
 */
export async function POST(request: NextRequest) {
  try {
    const { to } = await request.json();
    const parsed = validateEmail(to, { required: true });
    if (!parsed.ok) {
      return NextResponse.json({ success: false, error: parsed.error }, { status: 400 });
    }

    const ok = await sendEmail({
      to: parsed.value,
      subject: 'Bari360 test email',
      html: '<p style="font-family:system-ui,sans-serif;font-size:14px;">Brevo is connected correctly. This is a test message from your Bari360 admin panel.</p>',
      text: 'Brevo is connected correctly. This is a test message from your Bari360 admin panel.',
    });

    if (!ok) {
      return NextResponse.json(
        {
          success: false,
          error: 'Brevo did not accept the message. Check the Logs tab — the rejection reason is recorded there.',
        },
        { status: 502 },
      );
    }

    return NextResponse.json(
      { success: true, message: `Test email sent to ${parsed.value}.` },
      { status: 200 },
    );
  } catch (err) {
    return apiError(request, err);
  }
}
