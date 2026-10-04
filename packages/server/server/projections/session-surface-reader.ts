/**
 * projections/session-surface-reader.ts — LIVE.2's keyed read: the one row of a conversation, from the
 * materialised `SESSION_SURFACE` projection (an indexed lookup on the store's `day` column, which this
 * projection files under `sessionSurfaceKey(harness, conversationId)` — see `catalog.ts`). Synchronous,
 * bounded to one row; it never scans the journal and never touches a metric table (C1).
 */
import { SESSION_SURFACE } from './catalog'
import { sessionSurfaceKey, type SessionSurfaceRow } from './session-surface'
import type { ProjectionStore } from './store'

/** The store opened, and SESSION_SURFACE has been built and is not mid-rebuild (a half-built answer is no answer). */
export function sessionSurfaceReady(store: ProjectionStore): boolean {
  if (store.state !== 'open') return false
  const m = store.metas().get(SESSION_SURFACE.id)
  return m !== undefined && !m.rebuilding
}

export function readSessionSurface(store: ProjectionStore, harness: string, conversationId: string): SessionSurfaceRow | null {
  if (store.state !== 'open') return null
  const key = sessionSurfaceKey(harness, conversationId)
  const [row] = store.outputs(SESSION_SURFACE.id, { from: key, to: key }, 0, 1)
  if (!row) return null
  try { return JSON.parse(row.data) as SessionSurfaceRow } catch { return null }
}
