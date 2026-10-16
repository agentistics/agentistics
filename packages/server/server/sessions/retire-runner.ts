/**
 * Carries out pending retire requests (ATOMIC SPAWN §2.2) — on the SERVER's hub, never a poller of its
 * own.
 *
 * `createRetireRunner` consumes each snapshot the process's `session-hub.ts` produces (one poll, every
 * reader shares it), keeps the per-session QUIET STREAK in memory (two consecutive `waiting` polls,
 * `quietForMs` long) and asks the pure `retire-plan.ts` what to do. The expensive probes — the
 * transcript's unsettled background tasks and the pane's process tree — run only for a row whose
 * activity already says quiet. A kill happens ONCE: snapshots are consumed one at a time, the row's
 * request is re-read from the registry right before acting, and it is cleared in the same step that
 * marks the session ended.
 *
 * It runs only in the server process (`startRetireRunner` refuses elsewhere): one killer per machine.
 * With no server the request just waits on the row — `agentop session retire` says so.
 *
 * All IO is injected, so `retire-runner.test.ts` drives it with a fake backend and a fake clock.
 */
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import type { HarnessId } from '@agentistics/core'
import type { SessionSnapshot } from './sessions-host'
import type { SessionView } from './session-view'
import type { ManagedSession, RetireRequest } from './types'
import type { SessionPatch } from './registry'
import {
  activityReasons, decideRetire, nextStreak, retireNoteText, retireReasonsText,
  type QuietStreak, type RetireDecision,
} from './retire-plan'
import { WORK_CHILDREN_TRUSTED, type WorkChildrenResult } from './work-children'

export interface RetireRunnerDeps {
  readRegistry(): Promise<ManagedSession[]>
  patch(id: string, patch: SessionPatch): Promise<boolean>
  /** `backend.kill` — true when the backend confirms the pane is gone. */
  kill(id: string): Promise<boolean>
  /** Marks the row ended (`registry.retireSession`). */
  markEnded(id: string): Promise<void>
  fileInFolder(folderId: string, row: { id: string; conversationId?: string }): Promise<boolean>
  /** Unsettled background tasks in the row's transcript; `null` = cannot be read. */
  bgTasks(row: ManagedSession): Promise<number | null>
  /** The row's work children. */
  children(row: ManagedSession): Promise<WorkChildrenResult>
  /** A comment on the row's task (best effort). */
  comment(taskId: string, body: string): Promise<void>
  /** A user-facing notification (expire / cancel / retire). */
  notify(level: 'info' | 'warning', title: string, message: string): void
  /** Poll the fleet now (the kill is a fleet event). */
  refresh(id: string): void
  now(): number
  log?(line: string): void
}

export interface RetireRunner {
  /** One hub snapshot. Calls are queued: never two consumes at once. */
  consume(snap: SessionSnapshot): Promise<void>
}

const running = (v: SessionView | undefined): boolean =>
  v !== undefined && v.status === 'running' && v.activity !== 'exited'

const nameOf = (r: ManagedSession): string => (r.label ? `${r.label} (${r.id})` : r.id)

export function createRetireRunner(d: RetireRunnerDeps): RetireRunner {
  const streaks = new Map<string, QuietStreak>()
  let queue: Promise<void> = Promise.resolve()
  const log = d.log ?? (() => {})

  async function act(row: ManagedSession, req: RetireRequest, decision: RetireDecision): Promise<void> {
    if (decision.action === 'none' || decision.action === 'wait') return
    // Re-read: the request may have been cancelled or replaced since the snapshot's registry read.
    const fresh = (await d.readRegistry()).find(m => m.id === row.id)
    if (!fresh?.retire || fresh.retire.requestedAt !== req.requestedAt || fresh.retire.expiredAt) return
    const who = nameOf(fresh)
    const succ = req.successorId ? ` after hand-off to ${req.successorId}` : ''
    const notes = 'notes' in decision ? decision.notes.map(n => retireNoteText(n, fresh.harness)) : []

    if (decision.action === 'retire') {
      if (decision.kill && !(await d.kill(row.id))) {
        log(`[retire] could not confirm ${row.id} was killed — the request is kept`)
        return
      }
      await d.markEnded(row.id)
      await d.patch(row.id, { retire: null })
      streaks.delete(row.id)
      let filed = ''
      if (req.folderId) {
        const ok = await d.fileInFolder(req.folderId, { id: row.id, ...(fresh.conversationId ? { conversationId: fresh.conversationId } : {}) }).catch(() => false)
        filed = ok ? '' : ' (could not move it to its finished folder)'
      }
      const body = `Session ${who} retired${succ}${decision.kill ? ' once it was idle' : ' (it had already stopped)'}${filed}.${notes.length ? ` Note: ${notes.join('; ')}.` : ''}`
      log(`[retire] ${body}`)
      if (fresh.taskId) await d.comment(fresh.taskId, body).catch(() => {})
      d.notify('info', 'Session retired', body)
      d.refresh(row.id)
      return
    }
    if (decision.action === 'cancel') {
      await d.patch(row.id, { retire: null })
      streaks.delete(row.id)
      const body = `Retire of ${who} cancelled: its successor ${req.successorId} is no longer running, so the task keeps its current session.`
      log(`[retire] ${body}`)
      if (fresh.taskId) await d.comment(fresh.taskId, body).catch(() => {})
      d.notify('warning', 'Retire cancelled', body)
      return
    }
    // expire
    const why = retireReasonsText(decision.reasons)
    await d.patch(row.id, { retire: { ...req, expiredAt: new Date(d.now()).toISOString(), expiredReason: why } })
    streaks.delete(row.id)
    const body = `Session ${who} was NOT retired: the deadline passed while ${why}. Nothing was killed; end it by hand when it is done (\`agentop session kill ${row.id}\`).`
    log(`[retire] ${body}`)
    if (fresh.taskId) await d.comment(fresh.taskId, body).catch(() => {})
    d.notify('warning', 'Retire expired', body)
  }

  async function consumeOne(snap: SessionSnapshot): Promise<void> {
    // A failed poll hands back the PREVIOUS list: it says nothing new and must not advance a streak.
    if (snap.unavailable) return
    const pending = (await d.readRegistry()).filter(r => r.retire && !r.retire.expiredAt)
    const ids = new Set(pending.map(r => r.id))
    for (const id of [...streaks.keys()]) if (!ids.has(id)) streaks.delete(id)
    if (pending.length === 0) return
    const views = new Map(snap.sessions.map(v => [v.id, v]))
    const now = d.now()
    for (const row of pending) {
      const req = row.retire!
      const v = views.get(row.id)
      const streak = nextStreak(streaks.get(row.id) ?? null, v?.activity, snap.polledAtMs)
      if (streak) streaks.set(row.id, streak)
      else streaks.delete(row.id)
      const base = {
        running: running(v),
        ...(v?.activity ? { activity: v.activity } : {}),
        streak,
        childrenTrusted: WORK_CHILDREN_TRUSTED[row.harness as HarnessId] ?? false,
        successorAlive: req.successorId ? running(views.get(req.successorId)) : null,
      }
      // The probes cost a transcript read and a /proc walk: only for a row the activity says is quiet.
      const probe = base.running && base.successorAlive !== false && activityReasons(req, base).length === 0
      const [bgTasksRunning, children] = probe
        ? await Promise.all([d.bgTasks(row).catch(() => null), d.children(row).catch(() => null)])
        : [null, null]
      const decision = decideRetire(req, { ...base, bgTasksRunning, children }, now)
      try {
        await act(row, req, decision)
      } catch (e) {
        log(`[retire] ${row.id}: ${e instanceof Error ? e.message : String(e)}`)
      }
    }
  }

  return {
    consume(snap) {
      const next = queue.then(() => consumeOne(snap))
      queue = next.catch(() => undefined)
      return next
    },
  }
}

/**
 * The MCP launches a harness was CONFIGURED with, so its MCP servers are not read as work children.
 * `agentop mcp` is excluded for every harness by `work-children.ts` itself. claude reads its
 * `~/.claude.json` + the project's `.mcp.json` (the same parsers the MCP panel uses). The others are
 * `null`: their measured idle trees (work-children.ts, 2026-10-16) held only `agentop mcp`, and
 * nobody has written their MCP config reader for this — an extra MCP server configured there reads as
 * a work child, which can only delay a retire, never cause a wrong kill.
 */
export const MCP_COMMAND_SOURCES: Record<HarnessId, ((cwd: string) => Promise<string[]>) | null> = {
  claude: claudeMcpCommands,
  codex: null,
  gemini: null,
  copilot: null,
  antigravity: null,
  kimi: null,
  opencode: null,
}

async function claudeMcpCommands(cwd: string): Promise<string[]> {
  const { HOME_DIR } = await import('../config')
  const { serversFromClaudeJson, serversFromMcpJson, mergeScopes } = await import('../mcp-config')
  const json = async (f: string): Promise<unknown> => {
    try { return JSON.parse(await readFile(f, 'utf-8')) } catch { return null }
  }
  const dir = path.isAbsolute(cwd) ? cwd : undefined
  const servers = mergeScopes([
    ...serversFromClaudeJson(await json(path.join(HOME_DIR, '.claude.json')), dir),
    ...(dir ? serversFromMcpJson(await json(path.join(dir, '.mcp.json')), dir) : []),
  ])
  return servers.filter(s => s.command).map(s => [s.command!, ...(s.args ?? [])].join(' '))
}

/**
 * Attach the runner to the server's hub. Server process only (one killer per machine); never throws.
 * BACKGROUND demand, like the event producer: it keeps the hub ticking at its idle rate while nothing
 * moves, and costs nothing beyond one registry read per poll while no request is pending.
 */
export async function startRetireRunner(log: (line: string) => void = console.log): Promise<{ stop(): void } | null> {
  const { isServerProcess } = await import('./shared-snapshot')
  if (!isServerProcess()) return null
  let off: (() => void) | null = null
  let stopped = false
  // Same delay as the event producer: the hub lives behind `cli-start`, and importing it while the
  // server answers its first `/api/data` would compete with the app's first paint.
  const t = setTimeout(() => {
    void attachRetireRunner(log).then(o => { if (stopped) o?.(); else off = o })
  }, 3_000)
  return { stop() { stopped = true; clearTimeout(t); off?.() } }
}

async function attachRetireRunner(log: (line: string) => void): Promise<(() => void) | null> {
  try {
    const [{ ensureSessionHub }, reg, { resolveBackend }, { fileInFolder }, { readProcTree, workChildren }, { exeName }, { HARNESS_TRANSCRIPTS }, { broadcastNotification }, { kickFleet }] =
      await Promise.all([
        import('../cli-start'), import('./registry'), import('./index'), import('./cli-folder'),
        import('./work-children'), import('./process-conversation'), import('./harness-transcript'),
        import('../sse'), import('./fleet-web'),
      ])
    const backend = await resolveBackend()
    const hub = await ensureSessionHub()
    const runner = createRetireRunner({
      readRegistry: reg.readRegistry,
      patch: reg.patchSession,
      kill: id => backend.kill(id),
      markEnded: id => reg.retireSession(id),
      fileInFolder: (f, row) => fileInFolder(f, row),
      async bgTasks(row) {
        const reader = HARNESS_TRANSCRIPTS[row.harness]
        // No reader: the harness has no transcript format here, and no harness but Claude has the
        // background-task concept at all (spec 2.3) — 0 by construction.
        if (!reader) return 0
        if (!row.conversationId) return null
        const p = await reader.resolve({ conversationId: row.conversationId, cwd: row.cwd })
        if (!p) return null
        return (await reader.readRecent(p, 400)).filter(t => t.task?.running).length
      },
      async children(row) {
        const pid = (await backend.listPanePids?.())?.get(row.id)
        if (pid === undefined) return { checked: false, reason: 'unreadable' }
        const [tree, paneExe, mcp] = await Promise.all([
          readProcTree(pid), exeName(pid), MCP_COMMAND_SOURCES[row.harness]?.(row.cwd).catch(() => []) ?? [],
        ])
        return workChildren(tree, pid, row.harness, { paneExe, mcpCommands: mcp })
      },
      async comment(taskId, body) {
        const { addComment } = await import('./task-web')
        await addComment(taskId, { author: 'agentop', body })
      },
      notify: (level, title, message) => broadcastNotification({ type: level, title, message }),
      refresh: id => kickFleet(id),
      now: () => Date.now(),
      log,
    })
    const off = hub.subscribe(snap => { void runner.consume(snap).catch(() => {}) }, { background: true })
    log('[retire] carrying out retire requests on the server\'s poller')
    return off
  } catch (e) {
    log(`[retire] not started: ${e instanceof Error ? e.message : String(e)}`)
    return null
  }
}
