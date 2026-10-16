import type { SessionMeta } from '@agentistics/core'
import type { HarnessAdapter } from './types'
import { harnessEnabled } from './types'
import { join } from 'path'
import { CLAUDE_DIR, harnessRoots } from '../config'
import { loadSessionMetas, scanProjects } from '../data'

export const claudeAdapter: HarnessAdapter = {
  id: 'claude',
  dataRoot: CLAUDE_DIR,
  // Claude is the baseline harness: always present unless explicitly disabled,
  // with no directory requirement (legacy/missing sessions default to claude,
  // and stats-cache totals are claude). loadSessions() returns [] when ~/.claude
  // is absent, so an empty environment (e.g. CI) is handled gracefully.
  isAvailable() {
    return harnessEnabled('claude')
  },
  async loadSessions(): Promise<SessionMeta[]> {
    const roots = await harnessRoots('claude')
    return (await Promise.all(roots.map(r => loadClaudeRoot(r.root, r.account, r.isDefault)))).flat()
  },
}

/**
 * One claude root. The default root keeps the module's own paths (and its archive-free read); any
 * other root is read from `<root>/usage-data/session-meta` and `<root>/projects` and stamped with the
 * root's account. `stats-cache.json` is never read here: it stays the default root's, so a second
 * root cannot change the Claude totals (spec §4 D8).
 */
export async function loadClaudeRoot(root: string, account?: string, isDefault = root === CLAUDE_DIR): Promise<SessionMeta[]> {
  const metaMap = await loadSessionMetas(isDefault ? undefined : [join(root, 'usage-data', 'session-meta')])
  const knownIds = new Set(metaMap.keys())
  const { extraSessions } = await scanProjects(knownIds, metaMap, isDefault ? undefined : [join(root, 'projects')])
  const sessions = tagClaude([...metaMap.values(), ...extraSessions])
  return account ? sessions.map(s => ({ ...s, account })) : sessions
}

/** Sessions of every NON-default claude root; the default root is read by `buildApiResponse` itself. */
export async function claudeExtraRootSessions(): Promise<SessionMeta[]> {
  const roots = (await harnessRoots('claude')).filter(r => !r.isDefault)
  return (await Promise.all(roots.map(r => loadClaudeRoot(r.root, r.account, false)))).flat()
}

/**
 * PURE: the one line every session this adapter returns passes through.
 *
 * A session that already NAMES its harness is left alone — `loadSessionMetas` and `scanProjects`
 * are Claude's own sources today, and relabelling a session that arrived carrying another harness
 * would be this adapter claiming work it did not read.
 *
 * Extracted so the invariant can be tested where it lives. It used to be asserted only by an
 * end-to-end read of the real `~/.claude`, which proved almost nothing on CI (no such directory, so
 * the interesting assertion was skipped and `every()` was vacuous) and was a coin flip on the one
 * machine where it did run: the scan parses every transcript, and under load it exceeded its own
 * 120 s budget and failed commits that had touched no adapter. See `claude.test.ts`'s header.
 */
export function tagClaude(sessions: SessionMeta[]): SessionMeta[] {
  return sessions.map(s => (s.harness ? s : { ...s, harness: 'claude' as const }))
}
