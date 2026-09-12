import crypto from 'crypto';
import {
  getSetting,
  setSetting,
  normalisePopupItem,
  isPopupEmpty,
  DEFAULT_POPUP_SET,
  type PopupItem,
  type PopupSet,
} from './app-settings';

// =====================================================================================
// ✍️ SAVING A POPUP LIST — shared by the announcement and login-banner admin routes.
//
// Both routes take the same payload, enforce the same caps and refuse the same bad states, so the
// rules live once. Two copies of "what is a valid popup" is how one of them ends up accepting a
// 40 KB body or an http:// image six months from now.
// =====================================================================================

const MAX_TITLE = 120;
const MAX_BODY = 1000;

/**
 * How many popups one list may hold.
 *
 * Not a storage limit — it is a limit on how much a person can be asked to swipe through before
 * reaching the app. Ten is already more than anyone should publish at once.
 */
export const MAX_POPUP_ITEMS = 10;

/**
 * The image must be a URL the browser will actually load over https, and it must be one WE issued.
 *
 * These popups are shown to everyone, and the login banners to people with no account at all, so an
 * arbitrary attacker-supplied URL here is a tracking pixel aimed at the front door.
 * /api/admin/uploads returns Supabase storage URLs.
 */
function parseImageUrl(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null;
  const raw = String(value);
  if (!/^https:\/\//i.test(raw)) throw new Error('The image URL must start with https://.');
  if (raw.length > 500) throw new Error('That image URL is too long.');
  return raw;
}

/** Thrown for anything the admin can fix by editing the form. Routes turn it into a 400. */
export class PopupValidationError extends Error {}

/**
 * Validate and store a whole list.
 *
 * Whole-list replace rather than per-item PATCH: the editor holds the entire list anyway, and
 * reordering IS a list operation — a per-item API would still have needed a separate order call,
 * which is two ways to write the same thing.
 */
export async function savePopupList(key: string, rawItems: unknown): Promise<PopupSet> {
  if (!Array.isArray(rawItems)) {
    throw new PopupValidationError('Expected a list of popups.');
  }
  if (rawItems.length > MAX_POPUP_ITEMS) {
    throw new PopupValidationError(`You can have at most ${MAX_POPUP_ITEMS} popups in one list.`);
  }

  const items: PopupItem[] = rawItems.map((raw: any, n) => {
    // randomUUID for anything new. An id assigned here rather than by the browser is the one the
    // reorder and delete buttons will keep referring to, so it must not be client-chosen.
    const item = normalisePopupItem(raw || {}, crypto.randomUUID());
    return {
      ...item,
      titleEn: item.titleEn.slice(0, MAX_TITLE),
      titleBn: item.titleBn.slice(0, MAX_TITLE),
      bodyEn: item.bodyEn.slice(0, MAX_BODY),
      bodyBn: item.bodyBn.slice(0, MAX_BODY),
      imageUrl: parseImageUrl(raw?.imageUrl),
    };
  });

  // An empty popup is a blank modal in front of a real person with no way for them to tell what
  // went wrong. Refuse to publish one rather than ship that — but say WHICH, because in a list of
  // ten "one of them is empty" is not an actionable message.
  const blankActive = items.findIndex((i) => i.active && isPopupEmpty(i));
  if (blankActive >= 0) {
    throw new PopupValidationError(
      `Popup ${blankActive + 1} is switched on but has no image, title or details. Add something, or switch it off.`,
    );
  }

  // Ids must be unique or reorder and delete would act on the wrong row.
  const seen = new Set<string>();
  for (const i of items) {
    if (seen.has(i.id)) i.id = crypto.randomUUID();
    seen.add(i.id);
  }

  const next: PopupSet = { items, updatedAt: new Date().toISOString() };
  await setSetting(key, next);
  return next;
}

/** The stored list exactly as the admin left it, drafts included. */
export async function readPopupListForAdmin(key: string): Promise<PopupSet> {
  const stored = await getSetting<any>(key, DEFAULT_POPUP_SET);
  if (Array.isArray(stored?.items)) {
    return {
      items: stored.items.map((i: any, n: number) => normalisePopupItem(i || {}, `${key}-${n}`)),
      updatedAt: String(stored.updatedAt ?? ''),
    };
  }
  const one = normalisePopupItem(stored || {}, `${key}-0`);
  return isPopupEmpty(one)
    ? { items: [], updatedAt: String(stored?.updatedAt ?? '') }
    : { items: [one], updatedAt: String(stored?.updatedAt ?? '') };
}
