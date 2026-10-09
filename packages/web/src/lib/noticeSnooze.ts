/**
 * "Remind me later" for one-time notices (the PWA install prompt, the billing intro).
 *
 * Closing such a notice without ticking "don't show again" used to mean "ask me again on the next
 * reload" — so a person who dismissed it ten times saw it ten times. A close now snoozes the notice
 * for `NOTICE_SNOOZE_MS`; "don't show again" stays the permanent switch and is persisted elsewhere.
 * Per browser (localStorage); every access is guarded, and a store that cannot be read reads as
 * "not snoozed" — a notice may come back, it may never be lost.
 */
export const NOTICE_SNOOZE_MS = 7 * 24 * 60 * 60 * 1000

type Store = Pick<Storage, 'getItem' | 'setItem'>
const defaultStore = (): Store | null => { try { return localStorage } catch { return null } }

export function isNoticeSnoozed(key: string, now = Date.now(), store: Store | null = defaultStore()): boolean {
  try {
    const until = Number(store?.getItem(key))
    return Number.isFinite(until) && until > now
  } catch { return false }
}

export function snoozeNotice(key: string, now = Date.now(), store: Store | null = defaultStore(), ms = NOTICE_SNOOZE_MS): void {
  try { store?.setItem(key, String(now + ms)) } catch { /* private mode / quota: the notice just comes back */ }
}
