import type { HarnessId, SessionMeta } from '@agentistics/core'
import type { ServerProject } from '../data'

export interface HarnessAdapter {
  id: HarnessId
  /** On-disk root directory this harness reads from (used by the SSE file watcher). */
  dataRoot: string
  /** True when this harness's data directory exists on disk. */
  isAvailable(): boolean
  /** Normalized sessions with `harness` already set. Missing fields stay 0/undefined. */
  loadSessions(): Promise<SessionMeta[]>
  /** Optional harness-specific project discovery when not derivable from sessions. */
  loadProjects?(): Promise<ServerProject[]>
}

/** Env override: AGENTISTICS_HARNESS_<ID>=0 disables an adapter even if available. */
export function harnessEnabled(id: HarnessId): boolean {
  return process.env[`AGENTISTICS_HARNESS_${id.toUpperCase()}`] !== '0'
}

/** Lazily-resolved adapter list to avoid circular import issues (claude/codex import from types). */
let _adapters: HarnessAdapter[] | null = null

async function getAllAdapters(): Promise<HarnessAdapter[]> {
  if (_adapters) return _adapters
  const [{ claudeAdapter }, { codexAdapter }, { geminiAdapter }, { copilotAdapter }, { kimiAdapter }, { antigravityAdapter }, { opencodeAdapter }] = await Promise.all([
    import('./claude'),
    import('./codex'),
    import('./gemini'),
    import('./copilot'),
    import('./kimi'),
    import('./antigravity'),
    import('./opencode'),
  ])
  _adapters = [claudeAdapter, codexAdapter, geminiAdapter, copilotAdapter, kimiAdapter, antigravityAdapter, opencodeAdapter]
  return _adapters
}

/** Adapters whose data is present and not disabled via env. */
export async function getEnabledAdapters(): Promise<HarnessAdapter[]> {
  return (await getAllAdapters()).filter(a => a.isAvailable())
}
