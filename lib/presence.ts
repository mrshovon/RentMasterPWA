import { supabaseAdminEngine } from './supabase-server';

// =====================================================================================
// PRESENCE — "who is online right now" and "when was this account last seen".
//
// Backed by public.user_presence (see ADD_PRESENCE.sql): one row per (user, device),
// refreshed by a client heartbeat while the app is visible. Before that migration is run
// every read here degrades to "no presence data" rather than throwing, so the admin console
// keeps working — see MISSING_TABLE.
// =====================================================================================

// A user counts as online if they were seen within this window. Chosen to be comfortably
// longer than the client's 60s heartbeat, so one dropped ping doesn't flip someone offline.
export const ONLINE_WINDOW_MS = 5 * 60 * 1000;

// ADD_PRESENCE.sql has not been run yet. PostgREST answers `PGRST205` ("table not found in
// the schema cache") rather than Postgres's own `42P01` — both are checked because only the
// former is what actually comes back through supabase-js.
const MISSING_TABLE_CODES = ['PGRST205', '42P01'];
const isMissingTable = (code?: string) => MISSING_TABLE_CODES.includes(code || '');

export type PresenceRole = 'owner' | 'admin' | 'tenant';

export interface PresenceDevice {
  deviceId: string;
  platform: string | null;
  userAgent: string | null;
  lastSeenAt: string;
  firstSeenAt: string;
  online: boolean;
}

export interface PresenceSummary {
  online: boolean;
  lastSeenAt: string | null;
  devices: PresenceDevice[];
}

export const onlineCutoffIso = () => new Date(Date.now() - ONLINE_WINDOW_MS).toISOString();

/** Record (or refresh) one device's heartbeat. */
export async function touchPresence(args: {
  userId: string;
  deviceId: string;
  role: PresenceRole;
  platform?: string | null;
  userAgent?: string | null;
}): Promise<{ ok: boolean; error?: string }> {
  const now = new Date().toISOString();
  const { error } = await supabaseAdminEngine
    .from('user_presence')
    .upsert({
      user_id: args.userId,
      device_id: args.deviceId,
      role: args.role,
      platform: args.platform || null,
      user_agent: args.userAgent ? String(args.userAgent).slice(0, 400) : null,
      last_seen_at: now,
      // first_seen_at is NOT sent: the column default fills it on insert, and leaving it out
      // of the upsert means an existing row keeps its original value.
    }, { onConflict: 'user_id,device_id' });

  if (error) {
    if (isMissingTable(error.code)) {
      console.warn('[presence] user_presence is missing — run ADD_PRESENCE.sql. Heartbeat dropped.');
      return { ok: false, error: 'presence_not_migrated' };
    }
    return { ok: false, error: error.message };
  }
  return { ok: true };
}

/**
 * Presence for a set of users, keyed by user id. Users with no heartbeat are simply absent
 * from the map — callers should treat "missing" as "never seen".
 */
export async function getPresenceFor(userIds: string[]): Promise<Record<string, PresenceSummary>> {
  const out: Record<string, PresenceSummary> = {};
  if (!userIds.length) return out;

  const { data, error } = await supabaseAdminEngine
    .from('user_presence')
    .select('user_id, device_id, platform, user_agent, first_seen_at, last_seen_at')
    .in('user_id', userIds);

  if (error) {
    if (!isMissingTable(error.code)) console.error('[presence] lookup failed:', error.message);
    return out;
  }

  const cutoff = Date.now() - ONLINE_WINDOW_MS;
  for (const row of data || []) {
    const online = new Date(row.last_seen_at).getTime() >= cutoff;
    const entry = out[row.user_id] || (out[row.user_id] = { online: false, lastSeenAt: null, devices: [] });
    entry.devices.push({
      deviceId: row.device_id,
      platform: row.platform,
      userAgent: row.user_agent,
      lastSeenAt: row.last_seen_at,
      firstSeenAt: row.first_seen_at,
      online,
    });
    if (online) entry.online = true;
    // The account's last-seen is its most recently active device.
    if (!entry.lastSeenAt || row.last_seen_at > entry.lastSeenAt) entry.lastSeenAt = row.last_seen_at;
  }

  for (const entry of Object.values(out)) {
    entry.devices.sort((a, b) => (a.lastSeenAt < b.lastSeenAt ? 1 : -1));
  }
  return out;
}

export interface OnlineBreakdown {
  total: number;
  byRole: Record<string, number>;
  byPlatform: Record<string, number>;
}

/**
 * Who is online right now, counted by distinct USER (not device) so someone with the app open
 * on a phone and a laptop counts once. The per-platform breakdown does count a user under each
 * platform they are currently active on, which is what "how many are on Android" should mean.
 */
export async function getOnlineBreakdown(): Promise<OnlineBreakdown> {
  const empty: OnlineBreakdown = { total: 0, byRole: {}, byPlatform: {} };

  const { data, error } = await supabaseAdminEngine
    .from('user_presence')
    .select('user_id, role, platform')
    .gte('last_seen_at', onlineCutoffIso());

  if (error) {
    if (!isMissingTable(error.code)) console.error('[presence] online count failed:', error.message);
    return empty;
  }

  const seenUsers = new Set<string>();
  const seenUserPlatform = new Set<string>();
  for (const row of data || []) {
    if (!seenUsers.has(row.user_id)) {
      seenUsers.add(row.user_id);
      empty.total += 1;
      const role = row.role || 'unknown';
      empty.byRole[role] = (empty.byRole[role] || 0) + 1;
    }
    const platform = row.platform || 'unknown';
    const key = `${row.user_id}|${platform}`;
    if (!seenUserPlatform.has(key)) {
      seenUserPlatform.add(key);
      empty.byPlatform[platform] = (empty.byPlatform[platform] || 0) + 1;
    }
  }
  return empty;
}

/** Distinct users active between two instants — the "active users" figure for a date range. */
export async function countActiveUsers(fromIso: string, toIso: string): Promise<{ total: number; byRole: Record<string, number> }> {
  const result = { total: 0, byRole: {} as Record<string, number> };

  const { data, error } = await supabaseAdminEngine
    .from('user_presence')
    .select('user_id, role')
    .gte('last_seen_at', fromIso)
    .lte('last_seen_at', toIso);

  if (error) {
    if (!isMissingTable(error.code)) console.error('[presence] active-user count failed:', error.message);
    return result;
  }

  const seen = new Set<string>();
  for (const row of data || []) {
    if (seen.has(row.user_id)) continue;
    seen.add(row.user_id);
    result.total += 1;
    const role = row.role || 'unknown';
    result.byRole[role] = (result.byRole[role] || 0) + 1;
  }
  return result;
}
