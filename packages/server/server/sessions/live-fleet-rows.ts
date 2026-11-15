/**
 * LIVE.COLD-START — the rows the Live line reads, mapped straight off the hub's snapshot. PURE.
 *
 * `readLiveFleet` used to build its rows through `host.sessions()`, which maps the same snapshot with the
 * same `toControlSession` but first resolves `repoFacts` for every row (git, three processes per distinct
 * directory, memoized per process) and the crash offer's `restorableSessions`. On the first read after a
 * server start that is cold: measured over a 3.65k-row fleet, `repoFacts x3652` took 1–5 s and the Live's
 * first card waited 6–8 s for it. The Live reads none of those fields (repo, project group/root, dirGone,
 * worktree, restorable) — only identity, state, model/effort, account, parent, task, last lines and the
 * conversation id — so it maps the snapshot itself, the way `adapterRowOf` (adapter-chat-web.ts) already does.
 *
 * The rows therefore carry NO repository facts; nothing but the Live may read them for that.
 */
import type { ControlSession } from '@agentistics/tui/control'
import type { CliStrings } from '../cli-i18n'
import { toControlSession } from './control-session'
import type { SessionView } from './session-view'

export function liveFleetRows(
  snap: { sessions: readonly SessionView[] } | null | undefined,
  s: CliStrings,
  /** The engine's own sessions (`loadNativeFleet`), joined exactly as `host.sessions()` joins them. */
  native: readonly ControlSession[],
): ControlSession[] {
  if (!snap) return []
  const managedIds = new Set(snap.sessions.map(v => v.id))
  return [...snap.sessions.map(v => toControlSession(v, s)), ...native.filter(n => !managedIds.has(n.id))]
}
