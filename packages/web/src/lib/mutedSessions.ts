/**
 * mutedSessions.ts — the sessions whose notifications a person switched off.
 *
 * Muting suppresses DELIVERY only (bell, Nay card, shock, sound, toast, desktop). The session's
 * fleet state — `waiting` included — is never touched: a muted session that needs somebody still
 * says so on its row. Keyed by `sessionIdentityKey` (conversationId ?? id) so the mute survives a
 * reopen, which mints a new managed id for the same conversation. Absent = on.
 *
 * Stored on the SERVER through `sharedPref.ts`, exactly like `pinnedSessions.ts`.
 */

import { MAX_MUTED, planMute } from '@agentistics/core'
import { createSharedPref } from './sharedPref'

export { planMute }

const KEY = 'agentistics-muted-sessions'

const store = createSharedPref<string[]>({
  key: KEY,
  prefKey: 'mutedSessions',
  fallback: [],
  parse: raw => Array.isArray(raw)
    ? raw.filter((x): x is string => typeof x === 'string').slice(0, MAX_MUTED)
    : null,
})

export function getMutedKeys(): string[] {
  return store.get()
}

export function isSessionMuted(key: string): boolean {
  return store.get().includes(key)
}

export function setSessionMuted(key: string, muted: boolean): void {
  if (store.get().includes(key) === muted) return
  store.set(planMute(store.get(), key, muted))
}

export function toggleSessionMuted(key: string): boolean {
  const muted = !isSessionMuted(key)
  setSessionMuted(key, muted)
  return muted
}

export function subscribeMutedSessions(fn: () => void): () => void {
  return store.subscribe(fn)
}

export function mutedServerSnapshot(): string[] {
  return store.serverSnapshot()
}
