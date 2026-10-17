/**
 * checkinModal — the open state of the check-in details modal, as a tiny external store.
 *
 * The modal is STANDALONE: the chat row's "Open check-in", the ⓘ panel's "Open larger" and any other
 * surface call `openCheckinModal(sessionId)`; one `CheckinModalHost` (mounted once in App) draws it.
 * No component has to be mounted for the request to land, which is what the old window event needed
 * (and what the phone never had: its header does not mount the ⓘ).
 */
import { useSyncExternalStore } from 'react'

let current: { sessionId: string } | null = null
const listeners = new Set<() => void>()
const emit = () => listeners.forEach(l => l())

export function openCheckinModal(sessionId: string | undefined): void {
  if (!sessionId) return
  current = { sessionId }
  emit()
}

export function closeCheckinModal(): void {
  if (!current) return
  current = null
  emit()
}

export function useCheckinModalRequest(): { sessionId: string } | null {
  return useSyncExternalStore(
    listener => { listeners.add(listener); return () => { listeners.delete(listener) } },
    () => current,
    () => null,
  )
}

/** Non-hook read, for tests and imperative callers. */
export function readCheckinModalRequest(): { sessionId: string } | null { return current }
