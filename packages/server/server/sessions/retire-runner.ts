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
  MIN_QUIET_FOR_MS, activityReasons, decideRetire, nextStreak, retireNoteText, retireReasonsText,
  type QuietStreak, type RetireDecision,
} from './retire-plan'
import type { HarnessTranscript } from './harness-transcript'
import { WORK_CHILDREN_TRUSTED, type WorkChildrenResult } from './work-children'

export interface RetireRunnerDeps {
  readRegistry(): Promise<ManagedSession[]>
  patch(id: string, patch: SessionPatch): Promise<boolean>
  /** `backend.kill` — true when the backend confirms the pane is gone. */
  kill(id: string): Promise<boolean>
  /** A hub poll that starts after this call; never a cached activity read. */
  readFresh(): Promise<SessionSnapshot>
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
  notify(level: 'info' | 'warning', title: string, message: string, code: string, meta: Record<string, unknown>): void
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
  const missingSuccessors = new Map<string, { at: number; polls: number }>()
  const missingRows = new Map<string, { at: number; polls: number }>()
  const missingPastGrace = (row: ManagedSession, req: RetireRequest, at: number): boolean =>
    at > Math.max(Date.parse(row.createdAt), Date.parse(req.requestedAt)) + PREDECESSOR_GRACE_MS
  const lostRows = new Map<string, { at: number; polls: number }>()
  const confirm = (map: Map<string, { at: number; polls: number }>, id: string, at: number): boolean => {
    const prev = map.get(id)
    const polls = prev ? prev.polls + Number(at > prev.at) : 1
    map.set(id, { at: Math.max(at, prev?.at ?? at), polls })
    return polls >= 2
  }
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
      if (decision.kill) {
        const snap = await d.readFresh()
        const view = snap.sessions.find(v => v.id === row.id)
        const successor = req.successorId ? snap.sessions.find(v => v.id === req.successorId) : undefined
        const streak = nextStreak(streaks.get(row.id) ?? null, view?.activity, snap.polledAtMs)
        if (!snap.unavailable) {
          if (streak) streaks.set(row.id, streak)
          else streaks.delete(row.id)
        }
        // No further IO between this activity check and backend.kill.
        if (snap.unavailable || !running(view) ||
          (req.successorId && (!successor || ['exited', 'lost', 'closed'].includes(successor.status) || successor.activity === 'exited')) ||
          activityReasons(req, { activity: view?.activity, streak }).length ||
          d.now() >= Date.parse(req.deadlineAt)) return
      }
      if (!decision.kill) {
        const snap = await d.readFresh()
        const view = snap.sessions.find(v => v.id === row.id)
        if (snap.unavailable) return
        if (view) {
          missingRows.delete(row.id)
          if (!['exited', 'lost', 'closed'].includes(view.status)) { lostRows.delete(row.id); return }
          if (view.status === 'lost' && !confirm(lostRows, row.id, snap.polledAtMs)) return
        } else if (!missingPastGrace(fresh, req, snap.polledAtMs) ||
          !confirm(missingRows, row.id, snap.polledAtMs)) return
      }
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
      d.notify('info', 'Session retired', body, 'retire.done', { id: row.id, label: fresh.label ?? row.id, successorId: req.successorId ?? '', reason: '' })
      d.refresh(row.id)
      return
    }
    if (decision.action === 'cancel') {
      await d.patch(row.id, { retire: null })
      streaks.delete(row.id)
      const body = `Retire of ${who} cancelled: its successor ${req.successorId} is no longer running, so the task keeps its current session.`
      log(`[retire] ${body}`)
      if (fresh.taskId) await d.comment(fresh.taskId, body).catch(() => {})
      d.notify('warning', 'Retire cancelled', body, 'retire.cancelled', { id: row.id, label: fresh.label ?? row.id, successorId: req.successorId ?? '', reason: 'successor-dead' })
      return
    }
    // expire
    const why = retireReasonsText(decision.reasons)
    await d.patch(row.id, { retire: { ...req, expiredAt: new Date(d.now()).toISOString(), expiredReason: why } })
    streaks.delete(row.id)
    const body = `Session ${who} was NOT retired: the deadline passed while ${why}. Nothing was killed; end it by hand when it is done (\`agentop session kill ${row.id}\`).`
    log(`[retire] ${body}`)
    if (fresh.taskId) await d.comment(fresh.taskId, body).catch(() => {})
    d.notify('warning', 'Retire expired', body, 'retire.expired', { id: row.id, label: fresh.label ?? row.id, successorId: req.successorId ?? '', reason: decision.reasons[0]?.code ?? 'deadline', reasons: decision.reasons.map(r => r.code) })
  }

  async function consumeOne(snap: SessionSnapshot): Promise<void> {
    // A failed poll hands back the PREVIOUS list: it says nothing new and must not advance a streak.
    if (snap.unavailable) return
    const registry = await d.readRegistry()
    const pending = registry.filter(r => r.retire && !r.retire.expiredAt)
    const ids = new Set(pending.map(r => r.id))
    for (const id of [...streaks.keys()]) if (!ids.has(id)) streaks.delete(id)
    for (const id of missingRows.keys()) if (!ids.has(id)) missingRows.delete(id)
    for (const id of lostRows.keys()) if (!ids.has(id)) lostRows.delete(id)
    const successors = new Set(pending.map(r => r.retire!.successorId))
    for (const id of missingSuccessors.keys()) if (!successors.has(id)) missingSuccessors.delete(id)
    if (pending.length === 0) return
    const views = new Map(snap.sessions.map(v => [v.id, v]))
    const now = d.now()
    for (const row of pending) {
      const req = { ...row.retire!, quietForMs: Math.max(MIN_QUIET_FOR_MS, row.retire!.quietForMs) }
      let successorAlive: boolean | null = null
      if (req.successorId) {
        const sv = views.get(req.successorId)
        const sr = registry.find(r => r.id === req.successorId)
        if (sv) {
          missingSuccessors.delete(req.successorId)
          successorAlive = !['exited', 'lost', 'closed'].includes(sv.status) && sv.activity !== 'exited'
        } else if (sr?.endedAt) successorAlive = false
        else if (snap.polledAtMs > Math.max(Date.parse(sr?.createdAt ?? req.requestedAt), Date.parse(req.requestedAt)) + SUCCESSOR_GRACE_MS) {
          successorAlive = confirm(missingSuccessors, req.successorId, snap.polledAtMs) ? false : null
        } else missingSuccessors.delete(req.successorId)
      }
      const v = views.get(row.id)
      const streak = nextStreak(streaks.get(row.id) ?? null, v?.activity, snap.polledAtMs)
      if (streak) streaks.set(row.id, streak)
      else streaks.delete(row.id)
      // A missing row needs two distinct polls past birth/request grace; presence resets it.
      const missingStopped = !v && missingPastGrace(row, req, snap.polledAtMs) &&
        confirm(missingRows, row.id, snap.polledAtMs)
      if (v || !missingPastGrace(row, req, snap.polledAtMs)) missingRows.delete(row.id)
      const stopped = missingStopped || (!!v && (v.status === 'exited' || v.status === 'closed' ||
        (v.status === 'lost' && confirm(lostRows, row.id, snap.polledAtMs))))
      if (v?.status !== 'lost') lostRows.delete(row.id)
      const base = {
        running: !stopped,
        ...(v?.activity ? { activity: v.activity } : {}),
        streak,
        childrenTrusted: WORK_CHILDREN_TRUSTED[row.harness as HarnessId] ?? false,
        successorAlive,
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
      readFresh: () => hub.refresh(),
      markEnded: id => reg.retireSession(id),
      fileInFolder: (f, row) => fileInFolder(f, row),
      async bgTasks(row) {
        return readRetireBgTasks(row, HARNESS_TRANSCRIPTS)
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
      notify: (level, title, message, code, meta) => broadcastNotification({ type: level, title, message, code, meta }),
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

/** A successor can be born after the poll started; allow the registry's birth grace. */
export const SUCCESSOR_GRACE_MS = 30_000
export const PREDECESSOR_GRACE_MS = 30_000
export const RETIRE_TRANSCRIPT_MAX_BYTES = 64 * 1024 * 1024

export const BG_TASKS_APPLICABLE: Record<HarnessId, boolean> = {
  claude: true, codex: false, gemini: false, copilot: false,
  antigravity: false, kimi: false, opencode: false,
}

export async function readRetireBgTasks(
  row: ManagedSession,
  readers: Record<HarnessId, HarnessTranscript | null>,
): Promise<number | null> {
  if (!BG_TASKS_APPLICABLE[row.harness]) return 0
  const reader = readers[row.harness]
  if (!reader || !row.conversationId) return null
  try {
    const p = await reader.resolve({ conversationId: row.conversationId, cwd: row.cwd })
    if (!p) return null
    const window = await reader.read(p, Number.MAX_SAFE_INTEGER, { maxBytes: RETIRE_TRANSCRIPT_MAX_BYTES })
    return window.older ? null : window.turns.filter(t => t.task?.running).length
  } catch { return null }
}
