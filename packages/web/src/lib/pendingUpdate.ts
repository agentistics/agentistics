/**
 * pendingUpdate.ts — the one external store holding the update the bell keeps pinned. App feeds it
 * from `pinnedUpdate()` (updateToast.ts); the bell reads it. It is NOT a notification: it is never
 * persisted, read, cleared or dismissed — it is a fact about the running version.
 */
import { useSyncExternalStore } from 'react'
import type { PinnedUpdate } from './updateToast'

let current: PinnedUpdate | null = null
const listeners = new Set<() => void>()

export function setPendingUpdate(next: PinnedUpdate | null): void {
  const same = (!current && !next) || (current && next && current.latest === next.latest
    && current.current === next.current && current.critical === next.critical)
  if (same) return
  current = next
  listeners.forEach(l => l())
}

export function readPendingUpdate(): PinnedUpdate | null { return current }

export function usePendingUpdate(): PinnedUpdate | null {
  return useSyncExternalStore(cb => { listeners.add(cb); return () => { listeners.delete(cb) } }, () => current, () => current)
}
