import { supabaseAdminEngine } from './supabase-server';
import crypto from 'crypto';

// =====================================================================================
// Password reset audit log — one shared writer for all three reset paths so every row
// has an identical shape. Best-effort by design: a logging failure must NEVER break the
// reset itself (same posture as the fire-and-forget push in support-tickets). Callers can
// `await` it safely; it swallows its own errors.
// =====================================================================================

export type ResetMethod = 'admin_reset' | 'self_service_email' | 'self_change';

export interface LogPasswordResetInput {
  ownerId: string;
  ownerEmail?: string | null;
  resetBy?: string | null;   // acting admin id; omit/null for self-service
  method: ResetMethod;
  ip?: string | null;
}

export async function logPasswordReset(input: LogPasswordResetInput): Promise<void> {
  try {
    const { error } = await supabaseAdminEngine.from('password_reset_history').insert([
      {
        id: crypto.randomUUID(),                 // no DB default on id — generate here
        owner_id: input.ownerId,
        owner_email: input.ownerEmail ?? null,
        reset_by: input.resetBy ?? null,
        reset_method: input.method,
        ip: input.ip ?? null,
      },
    ]);
    if (error) console.error('[password-reset-log] insert failed (non-fatal):', error.message);
  } catch (err) {
    console.error('[password-reset-log] crash (non-fatal):', err);
  }
}

// Best-effort client IP from the standard proxy headers (matches middleware's approach:
// x-real-ip is edge-set and un-spoofable on Vercel; fall back to the first x-forwarded-for hop).
export function clientIpFrom(headers: Headers): string | null {
  const realIp = headers.get('x-real-ip');
  if (realIp) return realIp;
  const xff = headers.get('x-forwarded-for');
  if (xff) return xff.split(',')[0].trim() || null;
  return null;
}
