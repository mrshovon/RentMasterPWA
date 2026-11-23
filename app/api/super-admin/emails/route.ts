import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { supabaseAdminEngine } from '@/lib/supabase-server';
import { apiError } from '@/lib/api-response';
import { validateEmail, isSystemLogin } from '@/lib/validate';
import { isBrevoReady, sendEmail } from '@/lib/email/brevo';
import { adminMessage } from '@/lib/email/templates';
import { logEvent, actorFrom, routeFrom } from '@/lib/logger';

// =====================================================================================
// ✉️ SUPER ADMIN — COMPOSE AN EMAIL TO USERS
//
// GET  -> DRY RUN: how many people this selection would reach, a sample, and whether Brevo is on.
// POST -> actually send it (bilingual template, capped, batched, audited in app_logs).
//
// Four ways to choose recipients:
//   specific -> a list of user ids (the admin console already has them from /owners)
//   all      -> every Supabase auth user with a real mailbox
//   inactive -> users who have not signed in for N days (or never signed in)
//   custom   -> arbitrary email addresses typed by the admin
//
// Tenants are not Supabase auth users and have no email address, so they cannot be recipients.
// @bari360.com building logins are not mailboxes either — they are counted and skipped.
// Middleware already 403s any non-admin caller on /api/super-admin/*.
// =====================================================================================

const MODES = ['specific', 'all', 'inactive', 'custom'] as const;
type Mode = typeof MODES[number];

const MAX_RECIPIENTS = 100;
const MAX_SUBJECT = 200;
const MAX_BODY = 5000;
const BATCH_SIZE = 10;

// Attachments are uploaded through /api/admin/uploads into this one folder. The send request
// carries STORAGE PATHS, never URLs: a caller-supplied URL would be an SSRF primitive, and this
// way the only files we can attach are ones this app put in its own bucket.
const ATTACHMENT_FOLDER = 'email-attachments';
const STORAGE_BUCKET = 'RentMasterProDocs';
const MAX_ATTACHMENTS = 3;
const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;
const MAX_ATTACHMENT_TOTAL = 8 * 1024 * 1024;
const ATTACHMENT_EXTS = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'pdf'];

interface AttachmentInput { path: string; name: string }
interface PreparedAttachment { name: string; content: string }

/**
 * Download + base64-encode every attachment ONCE, before any mail is sent. A bad file therefore
 * fails the whole compose with a clear message rather than emailing half the recipients a mail
 * whose attachment is missing.
 */
async function prepareAttachments(raw: any): Promise<PreparedAttachment[]> {
  const list: AttachmentInput[] = Array.isArray(raw) ? raw : [];
  if (!list.length) return [];
  if (list.length > MAX_ATTACHMENTS) {
    throw new Error(`Attach at most ${MAX_ATTACHMENTS} files.`);
  }

  const out: PreparedAttachment[] = [];
  let total = 0;
  for (const item of list) {
    const path = String(item?.path || '');
    const ext = path.includes('.') ? path.split('.').pop()!.toLowerCase() : '';
    if (!path.startsWith(`${ATTACHMENT_FOLDER}/`) || path.includes('..') || !ATTACHMENT_EXTS.includes(ext)) {
      throw new Error('An attachment is not a supported image or PDF uploaded for email.');
    }
    // UUID filenames are unhelpful in an inbox; the caller sends the original name as metadata.
    const name = String(item?.name || 'attachment')
      .replace(/[^\w.\- ()]/g, '').trim().slice(0, 120) || 'attachment';

    const { data: blob, error } = await supabaseAdminEngine.storage.from(STORAGE_BUCKET).download(path);
    if (error || !blob) throw new Error(`Could not read the attachment "${name}". Please upload it again.`);

    const bytes = new Uint8Array(await blob.arrayBuffer());
    if (bytes.byteLength > MAX_ATTACHMENT_BYTES) {
      throw new Error(`"${name}" is over the 5MB per-file limit.`);
    }
    total += bytes.byteLength;
    if (total > MAX_ATTACHMENT_TOTAL) {
      throw new Error('Attachments exceed 8MB in total.');
    }
    out.push({ name, content: Buffer.from(bytes).toString('base64') });
  }
  return out;
}

interface Recipient {
  email: string;
  name: string | null;
  id?: string;
}

interface Selection {
  mode: Mode;
  ids: string[];
  emails: string[];
  inactiveDays: number;
}

function readSelection(raw: Record<string, any>, fromQuery = false): Selection {
  const mode: Mode = (MODES as readonly string[]).includes(raw?.mode) ? raw.mode : 'specific';
  const splitList = (v: any): string[] => {
    if (Array.isArray(v)) return v.map(String);
    return String(v ?? '').split(/[\s,;]+/).map((s) => s.trim()).filter(Boolean);
  };
  const days = Math.max(1, Math.min(3650, parseInt(raw?.inactiveDays ?? '30', 10) || 30));
  return {
    mode,
    ids: splitList(fromQuery ? raw.get?.('ids') : raw?.ids),
    emails: splitList(fromQuery ? raw.get?.('emails') : raw?.emails),
    inactiveDays: days,
  };
}

async function resolveRecipients(sel: Selection): Promise<{ recipients: Recipient[]; skippedSystem: number }> {
  let pool: Recipient[] = [];

  if (sel.mode === 'custom') {
    for (const raw of sel.emails) {
      const parsed = validateEmail(raw, { required: true });
      if (parsed.ok) pool.push({ email: parsed.value, name: null });
    }
  } else {
    const { data, error } = await supabaseAdminEngine.auth.admin.listUsers({ page: 1, perPage: 1000 });
    if (error) throw error;
    let users = data?.users || [];
    if (sel.mode === 'specific') {
      const wanted = new Set(sel.ids);
      users = users.filter((u) => wanted.has(u.id));
    } else if (sel.mode === 'inactive') {
      const cutoff = Date.now() - sel.inactiveDays * 24 * 60 * 60 * 1000;
      users = users.filter((u) => !u.last_sign_in_at || Date.parse(u.last_sign_in_at) < cutoff);
    }
    pool = users.map((u) => ({
      email: u.email || '',
      name: ((u.user_metadata as any) || {}).name || null,
      id: u.id,
    })).filter((r) => !!r.email);
  }

  const seen = new Set<string>();
  const recipients: Recipient[] = [];
  let skippedSystem = 0;
  for (const r of pool) {
    if (isSystemLogin(r.email)) { skippedSystem++; continue; }
    const key = r.email.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    recipients.push(r);
  }
  return { recipients, skippedSystem };
}

export async function GET(request: NextRequest) {
  try {
    const params = request.nextUrl.searchParams;
    const selection = readSelection({ get: (k: string) => params.get(k) }, true);
    const { recipients, skippedSystem } = await resolveRecipients(selection);
    const ready = await isBrevoReady();

    return NextResponse.json({
      success: true,
      mode: selection.mode,
      count: recipients.length,
      willSend: Math.min(recipients.length, MAX_RECIPIENTS),
      cap: MAX_RECIPIENTS,
      skippedSystem,
      ready,
      sample: recipients.slice(0, 5).map((r) => ({ email: r.email, name: r.name })),
    }, { status: 200 });
  } catch (err) {
    return apiError(request, err);
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const subjectEn = String(body?.subjectEn || '').trim().slice(0, MAX_SUBJECT);
    const bodyEn = String(body?.bodyEn || '').trim().slice(0, MAX_BODY);
    const subjectBn = String(body?.subjectBn || '').trim().slice(0, MAX_SUBJECT) || null;
    const bodyBn = String(body?.bodyBn || '').trim().slice(0, MAX_BODY) || null;
    if (!subjectEn || !bodyEn) {
      return NextResponse.json({ success: false, error: 'An English subject and message are required.' }, { status: 400 });
    }

    if (!(await isBrevoReady())) {
      return NextResponse.json({
        success: false,
        code: 'EMAIL_NOT_CONFIGURED',
        error: 'Email delivery is not switched on yet. Configure Brevo in Admin → Settings → Email first.',
      }, { status: 409 });
    }

    // Prepare files before any mail goes out — a bad attachment fails the whole compose.
    let attachments: PreparedAttachment[] = [];
    try {
      attachments = await prepareAttachments(body?.attachments);
    } catch (e: any) {
      return NextResponse.json({ success: false, error: e?.message || 'Could not prepare attachments.' }, { status: 400 });
    }

    const selection = readSelection(body);
    const { recipients, skippedSystem } = await resolveRecipients(selection);
    if (!recipients.length) {
      return NextResponse.json({ success: false, error: 'Nobody matches that selection.' }, { status: 400 });
    }

    const batch = recipients.slice(0, MAX_RECIPIENTS);
    let sent = 0;
    let failed = 0;
    for (let i = 0; i < batch.length; i += BATCH_SIZE) {
      const results = await Promise.all(batch.slice(i, i + BATCH_SIZE).map(async (r) => {
        try {
          return await sendEmail({
            to: r.email,
            toName: r.name || null,
            ...adminMessage({ name: r.name || 'there', subjectEn, subjectBn, bodyEn, bodyBn }),
            ...(attachments.length ? { attachments } : {}),
          });
        } catch {
          return false; // sendEmail is non-fatal by contract, but never let one row break the batch
        }
      }));
      for (const ok of results) { if (ok) sent++; else failed++; }
    }

    await logEvent({
      level: failed ? 'warn' : 'info',
      source: 'email',
      message: `Admin email sent: ${sent} accepted, ${failed} rejected, ${skippedSystem} system logins skipped (${selection.mode})`,
      context: {
        mode: selection.mode,
        subject: subjectEn,
        selected: recipients.length,
        sent,
        failed,
        attachments: attachments.length,
        skippedSystem,
        remaining: Math.max(0, recipients.length - MAX_RECIPIENTS),
      },
      ...actorFrom(request),
      ...routeFrom(request),
    });

    return NextResponse.json({
      success: true,
      sent,
      failed,
      skippedSystem,
      remaining: Math.max(0, recipients.length - MAX_RECIPIENTS),
      message: `Email sent to ${sent} recipient${sent === 1 ? '' : 's'}.`,
    }, { status: 200 });
  } catch (err) {
    return apiError(request, err);
  }
}
