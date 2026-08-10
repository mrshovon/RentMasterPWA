import crypto from 'crypto';
import { supabaseAdminEngine } from './supabase-server';
import { sendPushToUsers } from './push-send';
import { logEvent, describeError } from './logger';

// =====================================================================================
// 🔔 IN-APP NOTIFICATION — one place that writes a `notices` row and fires the matching push.
//
// There was no helper for this. Three call sites (the admin circulate route, deliverReminder, the
// welcome broadcast) each hand-rolled the same insert with the same fields and the same
// swallow-the-error wrapper, which is three chances for them to drift apart — and they already
// had, in whether they set `tag` and how much of the body they truncated.
//
// The pairing is the point. A notice with no push is a message nobody sees until they next open
// the app; a push with no notice vanishes the moment it is dismissed. Every system-generated
// message wants both.
//
// Both halves are non-fatal and independent: a failed push must not lose the inbox row, and a
// failed insert must not stop the push. Callers can `await` this safely — it never throws.
//
// ⚠️ Push TEXT IS ENGLISH ONLY, and structurally has to be. The language choice lives in the
// browser's localStorage and is never sent to the server, and the notification is rendered by the
// service worker (rent-master-pwa-ui/app/sw.ts), which has no access to the translation context
// either. The in-app notice CAN be translated, client-side, by adding its exact title/body to
// rent-master-pwa-ui/lib/notice-i18n.ts — so keep the strings passed in here fixed and quotable.
// =====================================================================================

/** How much of a message fits in a notification before the OS truncates it anyway. */
const PUSH_BODY_MAX = 180;

export interface NotifyInput {
  /** Owner auth uid, or a tenants.id. `device_tokens.user_id` holds either. */
  userId: string;
  audience: 'owner' | 'tenant';
  title: string;
  body: string;
  /** Where notificationclick should land. Defaults to the audience's dashboard. */
  url?: string;
  /** Push collapse key — a second notification with the same tag replaces the first. */
  tag?: string;
  /** Who it is from. 'system_admin' for anything the platform itself generates. */
  senderType?: 'owner' | 'system_admin';
  senderId?: string | null;
}

export async function notifyUser(input: NotifyInput): Promise<void> {
  const senderType = input.senderType ?? 'system_admin';
  const url = input.url ?? (input.audience === 'owner' ? '/owner' : '/tenant');

  // 1. The inbox row.
  try {
    const { error } = await supabaseAdminEngine.from('notices').insert([
      {
        id: crypto.randomUUID(), // no DB default on id
        sender_type: senderType,
        // For a platform-generated message the sender IS the platform. `sender_id` is not
        // nullable in practice on this table, so it points at the recipient — the row is scoped
        // by target_*_id regardless, and nothing reads sender_id for system notices.
        sender_id: input.senderId ?? input.userId,
        target_scope: input.audience === 'owner' ? 'individual_owner' : 'individual_tenant',
        target_owner_id: input.audience === 'owner' ? input.userId : null,
        target_tenant_id: input.audience === 'tenant' ? input.userId : null,
        title: input.title,
        content: input.body,
      },
    ]);
    if (error) throw error;
  } catch (err) {
    await logEvent({
      level: 'warn',
      source: 'api',
      message: `Notice insert failed for ${input.audience} ${input.userId}: ${input.title}`,
      detail: describeError(err).detail,
      context: { audience: input.audience, title: input.title },
    });
  }

  // 2. The push. Independent of step 1 — see the header note.
  try {
    await sendPushToUsers([input.userId], {
      title: input.title,
      body: input.body.slice(0, PUSH_BODY_MAX),
      url,
      ...(input.tag ? { tag: input.tag } : {}),
    });
  } catch (err) {
    await logEvent({
      level: 'warn',
      source: 'push',
      message: `Push dispatch threw for ${input.audience} ${input.userId}: ${input.title}`,
      detail: describeError(err).detail,
    });
  }
}

/** The common case: tell one owner something. */
export const notifyOwner = (input: Omit<NotifyInput, 'audience'>) =>
  notifyUser({ ...input, audience: 'owner' });
