/**
 * sessions/session-surface-deps.ts — what the session surfaces need to ask the journal (LIVE.2): the
 * ONE place the three gates meet, and the only importer of the live store besides the metrics route.
 *
 * Returns `undefined` — and opens NOTHING — unless ALL of: an engine is present (C2: a community build
 * keeps today's behaviour exactly and creates no file), `AGENTISTICS_PROJECTIONS` is on, and `sessions`
 * is named in `AGENTISTICS_PROJECTIONS_SURFACES` (opt-in; the default-on call is the owner's, LIVE.4).
 * A caller given `undefined` is the legacy path, byte for byte.
 */
import { featureOn, sessionsSurfaceOn } from '@agentistics/core'
import type { SessionSurfaceRow } from '../projections/session-surface'

export interface SessionSurfaceDeps {
  /** The journal's answer for one conversation. `ready: false` = the store is not open / not built / rebuilding. */
  lookup(harness: string, conversationId: string): Promise<{ ready: boolean; row: SessionSurfaceRow | null }>
}

type Env = Record<string, string | undefined>

export async function liveSessionSurfaceDeps(
  env: Env = process.env,
  enginePresent: () => boolean = () => false,
): Promise<SessionSurfaceDeps | undefined> {
  if (!enginePresent() || !sessionsSurfaceOn(env) || !featureOn('projections', env)) return undefined
  return {
    async lookup(harness, conversationId) {
      try {
        const [{ liveStoreForSessions }, { readSessionSurface, sessionSurfaceReady }] = await Promise.all([
          import('../runtime-metrics-web'), import('../projections/session-surface-reader'),
        ])
        const live = await liveStoreForSessions()
        if (!live || !sessionSurfaceReady(live.store)) return { ready: false, row: null }
        return { ready: true, row: readSessionSurface(live.store, harness, conversationId) }
      } catch {
        return { ready: false, row: null }
      }
    },
  }
}
