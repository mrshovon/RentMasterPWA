// =====================================================================================
// WHERE A CLICKABLE NOTICE MAY GO.
//
// The four dashboards keep their active tab in the URL hash (lib/use-tab.ts in the UI repo), so
// a destination is just a path plus optional #tab-key. This is the BACKEND half of the allow-list:
// accept only paths this app actually renders, or an admin typo becomes a notice that opens a
// blank screen. The UI has a mirrored list for its select box.
//
// Key traps encoded here: a tenant's Rent tab is 'billing'; a building admin's Service charge
// tab is 'invoices' (not 'service-charge'); the admin's Circulate tab is 'notices'.
// =====================================================================================

export const NOTICE_TARGETS = {
  owner: [
    '/owner', '/owner#overview', '/owner#properties', '/owner#tenants', '/owner#billing',
    '/owner#maintenance', '/owner#notices', '/owner#reminders', '/owner#staff',
    '/owner#accounts', '/owner#service-charge', '/owner#plan', '/owner#support', '/owner#settings',
  ],
  tenant: [
    '/tenant', '/tenant#overview', '/tenant#billing', '/tenant#maintenance',
    '/tenant#notices', '/tenant#documents', '/tenant#settings',
  ],
  building: [
    '/building', '/building#overview', '/building#plan', '/building#owners',
    '/building#invoices', '/building#spaces', '/building#staff', '/building#accounts',
    '/building#notices', '/building#reports', '/building#setup', '/building#settings',
  ],
  admin: [
    '/admin', '/admin#overview', '/admin#analytics', '/admin#owners',
    '/admin#subscriptions', '/admin#payments', '/admin#buildings',
    '/admin#payment-setup', '/admin#notices', '/admin#tickets', '/admin#messages',
    '/admin#reset-log', '/admin#logs', '/admin#settings',
  ],
  // A mixed audience cannot be sent to a role-specific dashboard. Home only.
  everyone: ['/'],
} as const;

export type NoticeAudience = keyof typeof NOTICE_TARGETS;

export function audienceForScope(scope: string): NoticeAudience {
  if (scope === 'all_tenants' || scope === 'individual_tenant') return 'tenant';
  if (scope === 'all_owners' || scope === 'individual_owner') return 'owner';
  return 'everyone';
}

export interface NoticeActionResult {
  ok: boolean;
  clickable: boolean;
  actionUrl: string | null;
  error?: string;
}

/**
 * `body.clickable` opt-in + `body.actionUrl` destination, validated for the notice's audience.
 * A non-clickable notice deliberately forgets any URL the caller sent — a half-configured link
 * must never show a "tap to open" sign on one client and do nothing on another.
 */
export function normalizeNoticeAction(
  audience: NoticeAudience,
  body: { clickable?: unknown; actionUrl?: unknown },
): NoticeActionResult {
  const clickable = body?.clickable === true || body?.clickable === 'true';
  if (!clickable) return { ok: true, clickable: false, actionUrl: null };

  const raw = String(body?.actionUrl ?? '').trim();
  if (!raw) {
    return { ok: false, clickable: false, actionUrl: null, error: 'Choose where the notice should open.' };
  }
  if (!(NOTICE_TARGETS[audience] as readonly string[]).includes(raw)) {
    return {
      ok: false,
      clickable: false,
      actionUrl: null,
      error: `That destination is not available for this audience.`,
    };
  }
  return { ok: true, clickable: true, actionUrl: raw };
}
