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

/**
 * The Hermes adapter is built HERE because `hermes.ts` carries no host capability (the delivery guard's
 * shrink-only ceilings): the paths, the existence probe and the memo it is handed live in modules that do.
 */
let _hermes: Promise<HarnessAdapter> | null = null
export function loadHermesAdapter(): Promise<HarnessAdapter> {
  _hermes ??= Promise.all([import('./hermes'), import('../config'), import('./file-memo'), import('./opencode-v2')])
    .then(([{ createHermesAdapter }, { HERMES_DIR, HERMES_DB_PATH }, { createFileMemo, registerMemo, versionOf }, { hasOpencodeDb }]) =>
      createHermesAdapter({
        dir: HERMES_DIR,
        dbPath: HERMES_DB_PATH,
        enabled: () => harnessEnabled('hermes'),
        exists: hasOpencodeDb, // a plain `existsSync` of the given path
        versionOf,
        memo: registerMemo(createFileMemo<SessionMeta[]>(4)),
      }))
  return _hermes
}

/** Lazily-resolved adapter list to avoid circular import issues (claude/codex import from types). */
let _adapters: HarnessAdapter[] | null = null

async function getAllAdapters(): Promise<HarnessAdapter[]> {
  if (_adapters) return _adapters
  const [{ claudeAdapter }, { codexAdapter }, { geminiAdapter }, { copilotAdapter }, { kimiAdapter }, { antigravityAdapter }, { opencodeAdapter }, hermesAdapter] = await Promise.all([
    import('./claude'),
    import('./codex'),
    import('./gemini'),
    import('./copilot'),
    import('./kimi'),
    import('./antigravity'),
    import('./opencode'),
    loadHermesAdapter(),
  ])
  _adapters = [claudeAdapter, codexAdapter, geminiAdapter, copilotAdapter, kimiAdapter, antigravityAdapter, opencodeAdapter, hermesAdapter]
  return _adapters
}

/** Adapters whose data is present and not disabled via env. */
export async function getEnabledAdapters(): Promise<HarnessAdapter[]> {
  return (await getAllAdapters()).filter(a => a.isAvailable())
}
