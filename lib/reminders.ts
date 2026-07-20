import { supabaseAdminEngine } from './supabase-server';
import { sendPushToUsers } from './push-send';
import crypto from 'crypto';

// =====================================================================================
// RENT REMINDERS — shared delivery used by the owner route (immediate/same-day) and the
// cron tick (future + monthly). Sends a push to each recipient tenant and drops a row into
// `notices` so it also appears in the tenant's in-app inbox. A 'monthly' reminder re-arms
// itself (scheduled_date advances one month); a 'once' reminder is marked 'sent'.
// =====================================================================================

// Placeholders the owner can use in a reminder message; resolved per tenant at send time.
export const REMINDER_PLACEHOLDERS = ['{tenant}', '{amount}', '{property}', '{month}', '{due_date}'];

export interface ReminderContext {
  tenant: string;
  amount: string;   // formatted, e.g. "৳12,000"
  property: string;
  month: string;    // "July 2026"
  due_date: string; // "5th"
}

export function resolveReminderMessage(template: string, ctx: ReminderContext): string {
  const base = (template && template.trim())
    ? template
    : 'Hello {tenant}, this is a reminder that your rent of {amount} for {month} is due. Please pay by the {due_date}.';
  return base
    .replace(/\{tenant\}/g, ctx.tenant)
    .replace(/\{amount\}/g, ctx.amount)
    .replace(/\{property\}/g, ctx.property)
    .replace(/\{month\}/g, ctx.month)
    .replace(/\{due_date\}/g, ctx.due_date);
}

function ordinal(day: number | null | undefined): string {
  const n = Number(day || 0);
  if (!n) return '';
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return `${n}${s[(v - 20) % 10] || s[v] || s[0]}`;
}

export interface ReminderRow {
  id: string;
  owner_id: string;
  target_all: boolean;
  tenant_ids: string[] | null;
  message: string;
  scheduled_date: string; // 'YYYY-MM-DD'
  recurrence: 'once' | 'monthly';
  status: string;
}

/**
 * Deliver one reminder to its recipient tenants, then advance/close it.
 * Returns how many tenants were notified. Never throws (best-effort per tenant).
 */
export async function deliverReminder(reminder: ReminderRow): Promise<number> {
  // Resolve recipients: target_all re-reads the owner's tenants at send time (so a monthly
  // "all tenants" reminder includes tenants added later).
  let tenantIds: string[] = reminder.tenant_ids || [];
  if (reminder.target_all) {
    const { data } = await supabaseAdminEngine.from('tenants').select('id').eq('owner_id', reminder.owner_id);
    tenantIds = (data || []).map((t) => t.id);
  }

  let sent = 0;
  if (tenantIds.length) {
    const { data: tenants } = await supabaseAdminEngine
      .from('tenants')
      .select('id, name, monthly_rent, due_date, properties:property_id ( name )')
      .in('id', tenantIds);

    const monthLabel = new Date().toLocaleString('en-US', { month: 'long', year: 'numeric' });

    for (const t of tenants || []) {
      const ctx: ReminderContext = {
        tenant: t.name || 'Tenant',
        amount: `৳${Number(t.monthly_rent || 0).toLocaleString()}`,
        property: ((t as any).properties?.name) || '',
        month: monthLabel,
        due_date: ordinal((t as any).due_date),
      };
      const msg = resolveReminderMessage(reminder.message, ctx);

      // In-app inbox row (tenants read these on their Notices tab).
      try {
        await supabaseAdminEngine.from('notices').insert([{
          id: crypto.randomUUID(),
          sender_type: 'owner',
          sender_id: reminder.owner_id,
          target_scope: 'individual_tenant',
          target_tenant_id: t.id,
          title: 'Rent reminder',
          content: msg,
        }]);
      } catch (e) {
        console.error('[reminders] notice insert failed (non-fatal):', e);
      }

      // Push (web + FCM).
      try {
        await sendPushToUsers([t.id], {
          title: 'Rent reminder',
          body: msg.slice(0, 180),
          url: '/tenant',
          tag: `reminder-${reminder.id}-${t.id}`,
        });
      } catch (e) {
        console.error('[reminders] push failed (non-fatal):', e);
      }
      sent++;
    }
  }

  // Advance (monthly) or close (once). Runs even with zero recipients so a monthly reminder
  // doesn't get stuck re-firing on the same past date.
  const now = new Date().toISOString();
  if (reminder.recurrence === 'monthly') {
    const next = new Date(`${reminder.scheduled_date}T00:00:00Z`);
    next.setUTCMonth(next.getUTCMonth() + 1);
    await supabaseAdminEngine.from('reminders').update({
      scheduled_date: next.toISOString().slice(0, 10),
      status: 'pending',
      last_sent_at: now,
      updated_at: now,
    }).eq('id', reminder.id);
  } else {
    await supabaseAdminEngine.from('reminders').update({
      status: 'sent',
      last_sent_at: now,
      updated_at: now,
    }).eq('id', reminder.id);
  }

  return sent;
}
