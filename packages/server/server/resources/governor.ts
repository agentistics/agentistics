/**
 * resources/governor.ts — PURE. Given the inventory, what to stop now and what to SAY.
 *
 * ## The line between killing and alerting
 *
 * The governor kills only what provably serves nobody, and alerts on everything else. A kill nobody
 * asked for is the most expensive mistake this module can make — a process that holds somebody's
 * work, killed by a rule, is work lost with nobody watching — so the kill list is short and each
 * entry names the fact that makes it safe:
 *
 *  - **an orphaned `agentop mcp`** — an MCP server speaks to ONE client over stdio; reparented to init
 *    there is no client left, ever. The orphan guard shipped in v2.101.2 makes a current mcp exit by
 *    itself; this covers the binaries older than that guard (the incident's two were exactly those).
 *  - **an `agentop mcp` whose owner SESSION has ended** — same reasoning, one step earlier: its
 *    client is gone even if something still holds its stdin.
 *  - **a registered helper whose owner ended, or that sat idle past its own declared timeout** — the
 *    helper SAID who it serves and for how long (helpers.ts); the governor holds it to that.
 *  - **a TEST LEFTOVER**: an agentop (cockpit, server, cli) running under a throwaway HOME (one made
 *    under a temp root) whose RECORDED owner session has ended — the assistant named in its process
 *    card, checked by pid AND start time, or its `CLAUDE_PID`. Found 2026-10-03: six `tuicheck`
 *    cockpits at 350 MB each, nobody's. No owner on record means NOT stopped, ever: being orphaned
 *    or old is not evidence that nobody is using it. The real HOME never matches.
 *
 * Everything else is an ALERT, never a silent kill: a live process over its budget, an old binary
 * still running, a heavy job. Each alert names the culprit and the one-click fix the UI offers.
 * `server` and `cockpit` are never killed by a rule — a detached main server looks exactly like an
 * orphan (`nohup agentop server &`) and is the one process whose death everyone notices. The
 * governor never acts on ITSELF.
 */

import type { AgentopProcess } from './inventory'

/** Per-kind memory budgets (RSS + swap). Measured steady states, with headroom. */
export const KIND_BUDGET_BYTES: Record<AgentopProcess['kind'], number> = {
  server: 2048 * 1024 * 1024,
  cockpit: 768 * 1024 * 1024,
  mcp: 256 * 1024 * 1024,
  watch: 256 * 1024 * 1024,
  cli: 512 * 1024 * 1024,
  helper: 1024 * 1024 * 1024,
  heavy: 4096 * 1024 * 1024,
}

/** A live process using this much CPU for a whole tick, with no owner alive, is spinning. */
export const SPIN_CPU_PERCENT = 90

export type KillReason = 'orphan-mcp' | 'owner-ended' | 'helper-idle' | 'helper-owner-ended' | 'test-leftover'
export type AlertReason = 'over-budget' | 'stale-binary' | 'spinning'

export interface Kill { pid: number; label: string; reason: KillReason; usedBytes: number | null }

/** The fix the UI offers next to an alert. `kill` sends SIGTERM; `restart` is the cockpit's own. */
export interface Fix {
  /**
   * `kill` — SIGTERM it. `restart-server` — `agentop restart server`. `reopen-cockpit` — quit the
   * cockpit and open it again (a current one does this by itself, see self-guard.ts).
   * `reconnect-session` — an MCP serving a LIVE session: killing it would take the session's tools
   * away, so the fix is to reconnect from inside the session (`/mcp`) or reopen it.
   */
  action: 'kill' | 'restart-server' | 'reopen-cockpit' | 'reconnect-session'
  pid: number
}

export interface Alert {
  pid: number
  label: string
  reason: AlertReason
  usedBytes: number | null
  budgetBytes?: number
  fix: Fix | null
}

export interface HelperState {
  id: string
  pid: number
  /** ms epoch of the last time something used it; null = never touched since registration. */
  lastUsedMs: number | null
  registeredMs: number
  idleTimeoutSec: number
  budgetBytes: number
}

export interface GovernorPlan { kills: Kill[]; alerts: Alert[] }

export function planGovernor(o: {
  inventory: AgentopProcess[]
  helpers: HelperState[]
  nowMs: number
  budgets?: Partial<Record<AgentopProcess['kind'], number>>
}): GovernorPlan {
  const kills: Kill[] = []
  const alerts: Alert[] = []
  const helpers = new Map(o.helpers.map(h => [h.pid, h]))
  const budgetOf = (p: AgentopProcess): number => {
    const h = p.kind === 'helper' ? helpers.get(p.pid) : undefined
    return h?.budgetBytes ?? o.budgets?.[p.kind] ?? KIND_BUDGET_BYTES[p.kind]
  }

  for (const p of o.inventory) {
    if (p.self) continue
    const kill = (reason: KillReason) => kills.push({ pid: p.pid, label: p.label, reason, usedBytes: p.usedBytes })

    if (p.kind === 'mcp') {
      if (p.orphan) { kill('orphan-mcp'); continue }
      if (p.owner && !p.owner.alive) { kill('owner-ended'); continue }
    }
    if ((p.kind === 'cockpit' || p.kind === 'server' || p.kind === 'cli' || p.kind === 'watch') && p.isolatedHome) {
      // ONLY a known owner that is provably gone. A process with no owner on record is never stopped
      // by this rule, however old or orphaned: a codex or gemini session sets no CLAUDE_PID, and its
      // backgrounded preview would otherwise be killed while the session that started it was still
      // working (release-0410 review: "never a live session's preview/test server"). Age and orphan
      // status are not evidence of abandonment — `cmd &` reparents to init immediately.
      if (p.owner !== null && !p.owner.alive) { kill('test-leftover'); continue }
    }
    if (p.kind === 'helper') {
      const h = helpers.get(p.pid)
      if (p.owner && !p.owner.alive) { kill('helper-owner-ended'); continue }
      if (h) {
        const since = h.lastUsedMs ?? h.registeredMs
        if (o.nowMs - since > h.idleTimeoutSec * 1000) { kill('helper-idle'); continue }
      }
    }

    const fixFor = (): Fix | null =>
      p.kind === 'server' ? { action: 'restart-server', pid: p.pid }
        : p.kind === 'cockpit' ? { action: 'reopen-cockpit', pid: p.pid }
          : { action: 'kill', pid: p.pid }

    if (p.stale) {
      const fix: Fix = p.kind === 'mcp' ? { action: 'reconnect-session', pid: p.pid } : fixFor()!
      alerts.push({ pid: p.pid, label: p.label, reason: 'stale-binary', usedBytes: p.usedBytes, fix })
    }
    const budget = budgetOf(p)
    if (p.usedBytes !== null && p.usedBytes > budget) {
      alerts.push({ pid: p.pid, label: p.label, reason: 'over-budget', usedBytes: p.usedBytes, budgetBytes: budget, fix: fixFor() })
    }
    // A spinning process whose owner is gone (or that never had one and is an orphan) is the
    // incident's second culprit in any shape the kill rules above did not already catch.
    if (p.cpuPercent !== null && p.cpuPercent >= SPIN_CPU_PERCENT && (p.orphan || (p.owner && !p.owner.alive)) && p.kind !== 'server') {
      alerts.push({ pid: p.pid, label: p.label, reason: 'spinning', usedBytes: p.usedBytes, fix: { action: 'kill', pid: p.pid } })
    }
  }
  return { kills, alerts }
}

/** May the UI's one-click `kill` act on this pid? Only on a non-self, non-server inventory entry. */
export function killAllowed(inventory: AgentopProcess[], pid: number): boolean {
  const p = inventory.find(x => x.pid === pid)
  return !!p && !p.self && p.kind !== 'server'
}
