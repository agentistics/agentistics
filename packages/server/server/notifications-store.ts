/**
 * notifications-store.ts — the bell's history, persisted ON THE MACHINE (or on the central).
 *
 * WHY NOT localStorage: the history is the user's inbox, not a browser preference. Opening the
 * dashboard from a phone must show the same notifications the desktop shows, and localStorage is
 * per-browser — a phone would always start empty. The server is the source of truth; a client
 * holds a cache at most.
 *
 * WHY NOT preferences.json: `writePreferences` merges a whole object on every PUT
 * (`{...current, ...prefs}`), so an unrelated preference change (theme, language) would rewrite
 * the notification list, and two concurrent PUTs would clobber each other's entries. Preferences
 * are small, bounded config; this is an append-heavy log with its own lifecycle. Separate file.
 *
 * CENTRAL vs MACHINE: a central's history belongs to the central and a machine's to the machine.
 * In Docker they are already isolated (the central mounts a named volume at ~/.agentistics), but
 * the filename is mode-dependent as well so a NATIVE central sharing a home dir with a native
 * machine still cannot mix the two inboxes.
 *
 * THE EVENT IS THE INSTANCE'S; THE STATE IS PERSONAL. A notification is a fact about this
 * instance, stored ONCE — never duplicated per account. What is per-account is what each person
 * did with it: `readBy` (who has seen it) and `hiddenFor` (who dismissed it). On a central,
 * dismissing hides the row for whoever asked and leaves it for everyone else; on a machine, where
 * there is exactly one user, it deletes.
 *
 * CONCURRENCY: two tabs — or a desktop and a phone — hit the same server process, so every
 * mutation runs as a read-modify-write serialized through `serialize`. Without it, "dismiss A" and
 * "dismiss B" firing together would each write the list they read before the other landed, and one
 * of the two deletions would be silently resurrected.
 */

import { join } from 'path'
import { AGENTISTICS_DATA_DIR, TEAM_CENTRAL } from './config'
import { subjectVisibleTo, type NotificationSubject, type NotificationAuthorityContext } from './notifications-authority'
import type { Principal } from './notifications-authority'

export type { NotificationSubject } from './notifications-authority'

export type NotificationType = 'error' | 'warning' | 'info' | 'success'

/**
 * Codes whose payload NAMES A PERSON other than the reader (`meta.user`, `meta.actor`,
 * `meta.account`). They reach only principals who may already see who else uses the instance —
 * see `canSeeMemberNames` in iam-view.ts, the same condition that gates the members panel and the
 * member filter.
 *
 * This is a RULE keyed by code, not a special case: the next notification that names somebody is
 * one entry here, and forgetting it shows up as a missing line in a list rather than as an absent
 * `if` buried in a handler. Someone who may not see names does not receive the row at all — a
 * redacted row would still disclose that a colleague did something, and when.
 */
export const CODES_NAMING_A_PERSON: ReadonlySet<string> = new Set([
  'central.member_connected', // meta.user  — which member came online
  'machine.renamed',          // meta.actor — the admin who renamed it
  'machine.reassigned',       // meta.actor + meta.account — the admin, and the new owner
])

/**
 * Viewer used when the instance has no accounts at all (a solo/member machine: no Mongo, no login,
 * `getPrincipal` always null). It is a real, stable identity — "the single local user of this
 * machine" — not an invented accountId. Keeping it as a viewer id means read/hidden state has ONE
 * code path instead of a parallel boolean branch that would drift from the per-account one.
 */
export const LOCAL_VIEWER = '@local'

/** Stored shape. `readBy` / `hiddenFor` hold viewer ids (account ids, or LOCAL_VIEWER). */
export interface StoredNotification {
  id: string
  type: NotificationType
  /** Localization code — the UI resolves the text at RENDER time from this plus `meta`, so a
   *  stored notification still follows the language toggle. The rendered string is never stored. */
  code?: string
  meta?: Record<string, unknown>
  /** Raw pre-localized strings, used only when there is no `code`. */
  title?: string
  message?: string
  ts: number
  /** What this notification is ABOUT — a machine, team, or account. Absent means
   *  instance-wide (see `notifications-authority.ts`). A row written before this field existed
   *  has none, and is treated exactly the same way: instance-wide, scoped only by the other rules
   *  (`hiddenFor`, `CODES_NAMING_A_PERSON`) — never retroactively hidden. */
  subject?: NotificationSubject
  /** Viewers who have read it. Absent/empty = unread by everyone. */
  readBy?: string[]
  /** Viewers who dismissed it. The row stays for everyone else. */
  hiddenFor?: string[]
  /** @deprecated legacy per-instance flag, migrated into `readBy` on read. */
  read?: boolean
}

/** What a client receives: the per-account state already resolved for this viewer. The wire shape
 *  is unchanged from before per-account state existed, so the frontend stays a dumb cache. */
export interface PublicNotification {
  id: string
  type: NotificationType
  code?: string
  meta?: Record<string, unknown>
  title?: string
  message?: string
  ts: number
  read: boolean
}

export interface NotificationInput {
  type: NotificationType
  code?: string
  meta?: Record<string, unknown>
  title?: string
  message?: string
  /** Set by the emitter when the notification is about a specific machine/team/account —
   *  see `notifications-authority.ts`. Omit for a genuinely instance-wide notification. */
  subject?: NotificationSubject
}

/** Who is asking, and what they are allowed to see. */
export interface Viewer {
  /** Account id, or LOCAL_VIEWER on an instance without accounts. */
  id: string
  /** Whether this viewer may see notifications that name other people. */
  canSeeNames: boolean
  /** True when the instance has accounts (a central): dismissing hides per-account instead of
   *  deleting, because one person's dismissal must not erase everyone else's copy. */
  multiTenant: boolean
  /**
   * Present only for a viewer backed by a real `Principal` (an authenticated account on a
   * central) — the role/team entitlement `subjectVisibleTo` checks a notification's `subject`
   * against. Absent for `localViewer` (a solo/member machine has no accounts to scope against,
   * so its one user sees everything, exactly as before this field existed) and for any caller
   * that constructs a bare `Viewer` without it — which must never happen for a real central
   * account, or every subject-scoped notification silently reaches them regardless of role.
   */
  entitlement?: { principal: Principal; ctx: NotificationAuthorityContext }
}

/** The viewer for an instance with no accounts — the machine's own user, who sees everything. */
export const localViewer: Viewer = { id: LOCAL_VIEWER, canSeeNames: true, multiTenant: false }

/** Bounded history — the newest N are kept. The cap is enforced on write so the file cannot grow
 *  without limit on a long-running central. */
export const MAX_ITEMS = 100

export const NOTIFICATIONS_FILE = join(
  AGENTISTICS_DATA_DIR,
  TEAM_CENTRAL ? 'notifications-central.json' : 'notifications.json',
)

interface StoreFile {
  version: 1
  items: StoredNotification[]
}

/** Serializes every mutation. Each op re-reads the file INSIDE the lock, so concurrent writers
 *  never base their write on a stale list. */
let queue: Promise<unknown> = Promise.resolve()
function serialize<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(fn, fn)
  // Keep the chain alive even if this op rejects, or every later write would inherit the rejection.
  queue = run.then(() => undefined, () => undefined)
  return run
}

function isValid(x: unknown): x is StoredNotification {
  if (!x || typeof x !== 'object') return false
  const n = x as StoredNotification
  return typeof n.id === 'string' && typeof n.ts === 'number' && typeof n.type === 'string'
}

/** Normalize a stored row, migrating the legacy per-instance `read` boolean into `readBy`. A file
 *  written before per-account state existed came from a single-user context, so its `read: true`
 *  means "the local user read it" — never "every account read it". */
function normalize(n: StoredNotification): StoredNotification {
  const readBy = Array.isArray(n.readBy)
    ? n.readBy.filter(x => typeof x === 'string')
    : (n.read === true ? [LOCAL_VIEWER] : [])
  const hiddenFor = Array.isArray(n.hiddenFor) ? n.hiddenFor.filter(x => typeof x === 'string') : []
  const { read: _legacy, ...rest } = n
  return { ...rest, readBy, hiddenFor }
}

/** Read the raw stored list (all viewers). A missing / empty / corrupt file yields an empty
 *  history rather than an error: a broken bell must never take down the dashboard. */
export async function readNotificationsFrom(path: string): Promise<StoredNotification[]> {
  try {
    const file = Bun.file(path)
    if (!(await file.exists())) return []
    const text = await file.text()
    if (!text.trim()) return []
    const parsed = JSON.parse(text) as Partial<StoreFile> | StoredNotification[]
    const items = Array.isArray(parsed) ? parsed : parsed.items
    if (!Array.isArray(items)) return []
    return items
      .filter(isValid)
      .map(normalize)
      .sort((a, b) => b.ts - a.ts)
      .slice(0, MAX_ITEMS)
  } catch (err) {
    console.error('[notifications] failed to read', path, err)
    return []
  }
}

/** Pure: is this row deliverable to `viewer`? Rows they dismissed, and rows naming a person they
 *  may not see, are simply absent. */
export function visibleTo(n: StoredNotification, viewer: Viewer): boolean {
  if ((n.hiddenFor ?? []).includes(viewer.id)) return false
  if (n.code && CODES_NAMING_A_PERSON.has(n.code) && !viewer.canSeeNames) return false
  if (viewer.entitlement && !subjectVisibleTo(viewer.entitlement.principal, n.subject, viewer.entitlement.ctx, n.code)) return false
  return true
}

/** Pure: project the stored rows onto what `viewer` receives, resolving `read` for them. */
export function projectFor(items: StoredNotification[], viewer: Viewer): PublicNotification[] {
  return items.filter(n => visibleTo(n, viewer)).map(n => ({
    id: n.id,
    type: n.type,
    code: n.code,
    meta: n.meta,
    title: n.title,
    message: n.message,
    ts: n.ts,
    read: (n.readBy ?? []).includes(viewer.id),
  }))
}

async function writeTo(path: string, items: StoredNotification[]): Promise<void> {
  const payload: StoreFile = { version: 1, items: items.slice(0, MAX_ITEMS) }
  await Bun.write(path, JSON.stringify(payload, null, 2))
}

/** Identity of a notification for dedupe purposes: same code+meta+subject (or same raw text) is
 *  the same event, regardless of which client reported it.
 *
 *  `subject` is part of the identity, not an afterthought: a code with no distinguishing `meta`
 *  (`iam.reset_requested` carries none at all) would otherwise let a SECOND account's event
 *  overwrite the stored row's subject on the dupe path below — collapsing two people's open
 *  requests into one row and silently reassigning who it is delivered to. */
function keyOf(n: NotificationInput | StoredNotification): string {
  const subjectKey = n.subject ? `${n.subject.kind}/${n.subject.id}` : ''
  return n.code
    ? `c:${n.code}:${JSON.stringify(n.meta ?? {})}:${subjectKey}`
    : `t:${n.title ?? ''}:${n.message ?? ''}:${subjectKey}`
}

let seq = 0
function nextId(): string {
  seq += 1
  return `n${Date.now().toString(36)}-${seq}`
}

/**
 * Add a notification, de-duping against one ALREADY IN THE HISTORY (read or not): the existing
 * entry moves to the top with a fresh timestamp and goes back to unread FOR EVERYONE, instead of a
 * second copy being appended. A re-occurrence is news to every account, not only to whoever
 * reported it — and `hiddenFor` resets for the same reason: the event happened again.
 *
 * Covering read items matters now that the history survives restarts. `app.update_available` is
 * re-emitted on every page load of an outdated machine (its client-side guard is a per-page-load
 * ref), and several clients can report the same SSE event — without this the list would grow one
 * duplicate per reload per device.
 */
export async function addNotificationTo(
  path: string, n: NotificationInput, viewer: Viewer = localViewer,
): Promise<PublicNotification[]> {
  return serialize(async () => {
    const items = await readNotificationsFrom(path)
    const now = Date.now()
    const key = keyOf(n)
    const dupe = items.find(x => keyOf(x) === key)
    const next = dupe
      ? [{ ...dupe, ts: now, readBy: [], hiddenFor: [], subject: n.subject }, ...items.filter(x => x.id !== dupe.id)]
      : [{ id: nextId(), ts: now, readBy: [], hiddenFor: [], ...n }, ...items]
    await writeTo(path, next)
    return projectFor(next.slice(0, MAX_ITEMS), viewer)
  })
}

/** Mark everything THIS VIEWER can see as read by THIS VIEWER. Another account's badge is
 *  untouched — reading is personal. */
export async function markAllReadIn(
  path: string, viewer: Viewer = localViewer,
): Promise<PublicNotification[]> {
  return serialize(async () => {
    const items = await readNotificationsFrom(path)
    let changed = false
    const next = items.map(n => {
      if (!visibleTo(n, viewer)) return n
      const readBy = n.readBy ?? []
      if (readBy.includes(viewer.id)) return n
      changed = true
      return { ...n, readBy: [...readBy, viewer.id] }
    })
    if (changed) await writeTo(path, next)
    return projectFor(next, viewer)
  })
}

/**
 * Dismiss ONE notification.
 *
 * On an instance with accounts this HIDES it for the caller and leaves it for everyone else — one
 * person clearing their bell must not erase a colleague's copy of an event that concerns them.
 * On a single-user machine it is a real delete: "hide from the only user" and "delete" are the
 * same thing there, and deleting keeps the file honest.
 *
 * Unknown ids are a no-op, not an error: two devices can dismiss the same row, and the second one
 * arriving must not fail.
 *
 * NO GARBAGE COLLECTION of rows hidden by every account, deliberately. Knowing "every account"
 * means querying Mongo from a file-backed store, coupling it to the accounts collection and making
 * every dismissal depend on a DB round-trip; and the account set changes — an account created
 * tomorrow would legitimately see the history. The list is capped at MAX_ITEMS, so a fully-hidden
 * row is bounded and is evicted by normal rotation.
 */
export async function dismissNotificationIn(
  path: string, id: string, viewer: Viewer = localViewer,
): Promise<PublicNotification[]> {
  return serialize(async () => {
    const items = await readNotificationsFrom(path)
    let next: StoredNotification[]
    if (viewer.multiTenant) {
      let changed = false
      next = items.map(n => {
        if (n.id !== id) return n
        const hiddenFor = n.hiddenFor ?? []
        if (hiddenFor.includes(viewer.id)) return n
        changed = true
        return { ...n, hiddenFor: [...hiddenFor, viewer.id] }
      })
      if (changed) await writeTo(path, next)
    } else {
      next = items.filter(x => x.id !== id)
      if (next.length !== items.length) await writeTo(path, next)
    }
    return projectFor(next, viewer)
  })
}

/** Clear everything THIS VIEWER can see — hiding it for them on a central, deleting it outright on
 *  a single-user machine. Rows the viewer cannot see are never touched. */
export async function clearNotificationsIn(
  path: string, viewer: Viewer = localViewer,
): Promise<PublicNotification[]> {
  return serialize(async () => {
    const items = await readNotificationsFrom(path)
    let next: StoredNotification[]
    if (viewer.multiTenant) {
      let changed = false
      next = items.map(n => {
        if (!visibleTo(n, viewer)) return n
        changed = true
        return { ...n, hiddenFor: [...(n.hiddenFor ?? []), viewer.id] }
      })
      if (changed) await writeTo(path, next)
    } else {
      next = []
      if (items.length > 0) await writeTo(path, next)
    }
    return projectFor(next, viewer)
  })
}

/** Read the history as `viewer` sees it. */
export async function listNotificationsFor(
  path: string, viewer: Viewer,
): Promise<PublicNotification[]> {
  return projectFor(await readNotificationsFrom(path), viewer)
}

// Bound to the real path — the exported API used by the server.
export const readStoredNotifications = (viewer: Viewer = localViewer) =>
  listNotificationsFor(NOTIFICATIONS_FILE, viewer)
export const addStoredNotification = (n: NotificationInput, viewer: Viewer = localViewer) =>
  addNotificationTo(NOTIFICATIONS_FILE, n, viewer)
export const markStoredNotificationsRead = (viewer: Viewer = localViewer) =>
  markAllReadIn(NOTIFICATIONS_FILE, viewer)
export const dismissStoredNotification = (id: string, viewer: Viewer = localViewer) =>
  dismissNotificationIn(NOTIFICATIONS_FILE, id, viewer)
export const clearStoredNotifications = (viewer: Viewer = localViewer) =>
  clearNotificationsIn(NOTIFICATIONS_FILE, viewer)
