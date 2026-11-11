/**
 * notifications-store.ts — the bell's history, persisted ON THE MACHINE.
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
 * CONCURRENCY: two tabs — or a desktop and a phone — hit the same server process, so every
 * mutation runs as a read-modify-write serialized through `serialize`. Without it, "dismiss A" and
 * "dismiss B" firing together would each write the list they read before the other landed, and one
 * of the two deletions would be silently resurrected.
 */

import { join } from 'path'
import { AGENTISTICS_DATA_DIR } from './config'

export type NotificationType = 'error' | 'warning' | 'info' | 'success'

/** Legacy marker: rows written before the flag became a plain boolean recorded who had read them. */
const LEGACY_READER = '@local'

/** Stored shape. */
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
  read?: boolean
}

/** What a client receives. */
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
}

/** Bounded history — the newest N are kept. The cap is enforced on write so the file cannot grow
 *  without limit on a long-running server. */
export const MAX_ITEMS = 100

export const NOTIFICATIONS_FILE = join(AGENTISTICS_DATA_DIR, 'notifications.json')

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

/** Normalize a stored row. A file written by an older version carried `readBy`/`hiddenFor` lists;
 *  a row only this machine's user read maps to `read: true`, and a dismissed row is not kept. */
function normalize(n: StoredNotification & { readBy?: unknown; hiddenFor?: unknown }): StoredNotification | null {
  if (Array.isArray(n.hiddenFor) && n.hiddenFor.length > 0) return null
  const read = n.read === true || (Array.isArray(n.readBy) && n.readBy.includes(LEGACY_READER))
  const { readBy: _r, hiddenFor: _h, subject: _s, ...rest } = n as typeof n & { subject?: unknown }
  return { ...rest, read }
}

/** Read the raw stored list. A missing / empty / corrupt file yields an empty history rather than
 *  an error: a broken bell must never take down the dashboard. */
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
      .filter((n): n is StoredNotification => n !== null)
      .sort((a, b) => b.ts - a.ts)
      .slice(0, MAX_ITEMS)
  } catch (err) {
    console.error('[notifications] failed to read', path, err)
    return []
  }
}

/** Pure: project the stored rows onto what a client receives. */
export function project(items: StoredNotification[]): PublicNotification[] {
  return items.map(n => ({
    id: n.id,
    type: n.type,
    code: n.code,
    meta: n.meta,
    title: n.title,
    message: n.message,
    ts: n.ts,
    read: n.read === true,
  }))
}

async function writeTo(path: string, items: StoredNotification[]): Promise<void> {
  const payload: StoreFile = { version: 1, items: items.slice(0, MAX_ITEMS) }
  await Bun.write(path, JSON.stringify(payload, null, 2))
}

/** Identity of a notification for dedupe purposes: same code+meta (or same raw text) is the same
 *  event, regardless of which client reported it. */
function keyOf(n: NotificationInput | StoredNotification): string {
  // Long-running client notices deliberately carry a stable identity while their state and
  // progress change.  They must update one bell row instead of appending one row per poll.
  const stableKey = typeof n.meta?.notificationKey === 'string' ? n.meta.notificationKey : ''
  if (stableKey) return `k:${stableKey}`
  return n.code
    ? `c:${n.code}:${JSON.stringify(n.meta ?? {})}`
    : `t:${n.title ?? ''}:${n.message ?? ''}`
}

let seq = 0
function nextId(): string {
  seq += 1
  return `n${Date.now().toString(36)}-${seq}`
}

/**
 * Add a notification, de-duping against one ALREADY IN THE HISTORY (read or not): the existing
 * entry moves to the top with a fresh timestamp and goes back to unread, instead of a second copy
 * being appended.
 *
 * Covering read items matters because the history survives restarts. `app.update_available` is
 * re-emitted on every page load of an outdated machine (its client-side guard is a per-page-load
 * ref), and several clients can report the same SSE event — without this the list would grow one
 * duplicate per reload per device.
 */
export async function addNotificationTo(path: string, n: NotificationInput): Promise<PublicNotification[]> {
  return serialize(async () => {
    const items = await readNotificationsFrom(path)
    const now = Date.now()
    const key = keyOf(n)
    const dupe = items.find(x => keyOf(x) === key)
    const next = dupe
      ? [{ ...dupe, ...n, id: dupe.id, ts: now, read: false }, ...items.filter(x => x.id !== dupe.id)]
      : [{ id: nextId(), ts: now, read: false, ...n }, ...items]
    await writeTo(path, next)
    return project(next.slice(0, MAX_ITEMS))
  })
}

/** Mark everything as read. */
export async function markAllReadIn(path: string): Promise<PublicNotification[]> {
  return serialize(async () => {
    const items = await readNotificationsFrom(path)
    let changed = false
    const next = items.map(n => {
      if (n.read === true) return n
      changed = true
      return { ...n, read: true }
    })
    if (changed) await writeTo(path, next)
    return project(next)
  })
}

/**
 * Dismiss ONE notification (a real delete).
 *
 * Unknown ids are a no-op, not an error: two devices can dismiss the same row, and the second one
 * arriving must not fail.
 */
export async function dismissNotificationIn(path: string, id: string): Promise<PublicNotification[]> {
  return serialize(async () => {
    const items = await readNotificationsFrom(path)
    const next = items.filter(x => x.id !== id)
    if (next.length !== items.length) await writeTo(path, next)
    return project(next)
  })
}

/** Clear the whole history. */
export async function clearNotificationsIn(path: string): Promise<PublicNotification[]> {
  return serialize(async () => {
    const items = await readNotificationsFrom(path)
    if (items.length > 0) await writeTo(path, [])
    return []
  })
}

/** Read the history. */
export async function listNotifications(path: string): Promise<PublicNotification[]> {
  return project(await readNotificationsFrom(path))
}

// Bound to the real path — the exported API used by the server.
export const readStoredNotifications = () => listNotifications(NOTIFICATIONS_FILE)
export const addStoredNotification = (n: NotificationInput) => addNotificationTo(NOTIFICATIONS_FILE, n)
export const markStoredNotificationsRead = () => markAllReadIn(NOTIFICATIONS_FILE)
export const dismissStoredNotification = (id: string) => dismissNotificationIn(NOTIFICATIONS_FILE, id)
export const clearStoredNotifications = () => clearNotificationsIn(NOTIFICATIONS_FILE)
