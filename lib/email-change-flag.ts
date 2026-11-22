import { supabaseAdminEngine } from './supabase-server';
import { logEvent, describeError } from './logger';

// =====================================================================================
// PER-OWNER OPT-IN: may this person change their own sign-in email?
//
// Stored in owner_addons (service-role only) under a reserved key. It is deliberately NOT in
// auth user_metadata: that object is writable by the account holder with the shipped anon key,
// so a permission kept there could be self-granted — the same reason the paid add-ons live here.
// The key is plain text, so no migration is needed to add it.
//
// Reads degrade to false on any error (including owner_addons predating a migration), which is
// the safe direction: a broken flag check must never open a write path.
// =====================================================================================

export const SELF_EMAIL_CHANGE_KEY = 'self_email_change';

function isMissingSchema(error: { code?: string } | null | undefined): boolean {
  return error?.code === 'PGRST205' || error?.code === 'PGRST204' || error?.code === '42P01' || error?.code === '42703';
}

export async function selfEmailChangeEnabled(ownerId: string): Promise<boolean> {
  try {
    const { data, error } = await supabaseAdminEngine
      .from('owner_addons')
      .select('enabled')
      .eq('owner_id', ownerId)
      .eq('addon_key', SELF_EMAIL_CHANGE_KEY)
      .maybeSingle();
    if (error) {
      if (!isMissingSchema(error)) {
        await logEvent({
          level: 'warn',
          source: 'api',
          message: `Self-service email-change flag could not be read for ${ownerId}`,
          detail: describeError(error).detail,
          context: { ownerId },
        });
      }
      return false;
    }
    return !!data?.enabled;
  } catch {
    return false;
  }
}

/**
 * Turn the opt-in on or off. A successful self-service change calls this with `false` — the
 * permission is one-shot, so the owner must be opted in again next time.
 */
export async function setSelfEmailChange(
  ownerId: string,
  enabled: boolean,
  grantedBy: string | null,
): Promise<void> {
  const { error } = await supabaseAdminEngine
    .from('owner_addons')
    .upsert({
      owner_id: ownerId,
      addon_key: SELF_EMAIL_CHANGE_KEY,
      enabled,
      granted_by: grantedBy,
      granted_at: new Date().toISOString(),
    }, { onConflict: 'owner_id,addon_key' });
  if (error) throw error;
}
