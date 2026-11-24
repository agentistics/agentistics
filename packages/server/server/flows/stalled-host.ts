/** IO for sessao-parada. The engine owns episodes, timers, handbacks and delivery cadence. */
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { activeEvidence, withoutClocks, activityApplies } from '@agentistics/core'
import { gitEnv } from '../backup/repo-probe'
import { detectLimit, limitRuleFor } from '../sessions/limit'
import { managedIdOf } from '../browser/browser-caller-proc'
import { createHeavyLockScanner } from '../sessions/heavy-lock-scan'
import { currentLeaderId } from '../sessions/team-links'
import type { ManagedSession } from '../sessions/types'
import type { SessionSnapshot } from '../sessions/sessions-host'
import { defaultMessageDeps, sendSessionMessage } from '../sessions/session-message'

const exec = promisify(execFile)

/**
 * The process-wide heavy-lock reading: ONE `ps` listing per tick shared by the fleet poll (sidebar, Live) and
 * every stalled-worker observation. Linux only; anywhere else it answers "no heavy signal".
 */
export const heavyLockScanner = createHeavyLockScanner({
  platform: process.platform,
  ps: async () => (await exec('ps', ['-eo', 'pid=,ppid=,args='], { timeout: 5_000, maxBuffer: 8 * 1024 * 1024 })).stdout,
  managedIdOf,
  now: Date.now,
})
const refuse = (reason: string) => ({ refused: true, reason, missing: ['fresh managed worker observation'] })
const input = (v: unknown): Record<string, unknown> => v && typeof v === 'object' ? v as Record<string, unknown> : {}

export interface StalledHostDeps {
  registry(): Promise<readonly ManagedSession[]>
  snapshot(): Promise<Pick<SessionSnapshot, 'sessions' | 'polledAtMs' | 'unavailable'>>
  role(row: ManagedSession): Promise<string | undefined>
  dirty(cwd: string): Promise<boolean | null>
  /** This session waits on / holds the heavy-job lock (default: the fleet's shared once-per-tick scan). */
  heavyLock(row: ManagedSession): Promise<boolean | 'waiting' | 'holding'>
  message(from: string, to: string, body: string): Promise<{ ok: boolean; message?: string; code?: string }>
  now(): number
}

export function defaultStalledHostDeps(): StalledHostDeps {
  return {
    registry: async () => (await import('../sessions/registry')).readRegistry(),
    snapshot: async () => (await import('../cli-start')).readRawFleetSnapshot(),
    role: async row => (await import('../sessions/session-roles')).storedRoleFor([row.conversationId, row.id]),
    dirty: async cwd => {
      try { return (await exec('git', ['--no-optional-locks', '-c', 'core.fsmonitor=false', '-C', cwd, 'status', '--porcelain=v1', '-z', '--untracked-files=all'], { timeout: 15_000, env: gitEnv() })).stdout.length > 0 } catch { return null }
    },
    heavyLock: async row => heavyLockScanner.of(row.id),
    message: async (from, to, body) => sendSessionMessage(from, { to, body, kind: 'block' }, await defaultMessageDeps()),
    now: Date.now,
  }
}

/** Kept for callers that only ask "is any heavy-lock process of this session around": the shared scan, as a boolean. */
export async function sessionOnHeavyLock(row: Pick<ManagedSession, 'id'>): Promise<boolean> {
  return (await heavyLockScanner.of(row.id)) !== false
}

/** What each observer last saw of a session's screen, per deps instance: "output moved since last time". */
const screenSeen = new WeakMap<object, Map<string, string>>()
const screenKey = (lines: readonly string[] | undefined): string => createHash('sha256').update(withoutClocks(lines ?? []).join('\n')).digest('hex').slice(0, 16)

export function stalledHostOps(d: StalledHostDeps = defaultStalledHostDeps()) {
  const target = async (value: unknown) => {
    const id = input(value).sessionId
    if (typeof id !== 'string' || !id) return null
    const rows = await d.registry()
    const row = rows.find(r => r.id === id)
    if (!row || row.endedAt || await d.role(row) !== 'worker') return null
    const parent = row.parentSessionId ?? rows.find(r => r.conversationId === row.parentConversationId)?.id
    const leader = parent ? rows.find(r => r.id === currentLeaderId(rows, parent)) : undefined
    if (!leader || leader.endedAt || leader.id === row.id || await d.role(leader) !== 'leader') return null
    return { row, leader }
  }
  return {
    'observar-sessao-parada': async (value: unknown) => {
      const t = await target(value)
      if (!t) return refuse('a live worker and its current leader are required')
      const snap = await d.snapshot()
      const age = d.now() - snap.polledAtMs
      if (snap.unavailable || !Number.isFinite(age) || age < 0 || age > 120_000) return refuse('the fleet observation is unavailable or stale')
      const view = snap.sessions.find(r => r.id === t.row.id)
      // Same applicability rule as the sidebar's mapper: a finished session has no live reading.
      if (!view || !['waiting', 'waiting-approval', 'working'].includes(view.activity ?? '') || !activityApplies(view.status)) return refuse('the worker has no live activity reading')
      const last = view.chatTurns?.at(-1)
      // Prefer transcript content for the notice text; the screen is the fallback.
      const text = (last?.text ?? view.lastLines?.join('\n') ?? '').slice(-2000)
      // OUTPUT: did the screen move since this observer last looked? (the poller's own digest, when the
      // view carries it, counts too). The first observation of a session has nothing to compare with.
      const seen = screenSeen.get(d) ?? screenSeen.set(d, new Map()).get(d)!
      const key = screenKey(view.lastLines)
      const prev = seen.get(t.row.id)
      seen.set(t.row.id, key)
      const outputMoved = view.outputMoved === true || (prev !== undefined && prev !== key)
      // ONE activity source (`sessionActivity.ts`), the same inputs the sidebar and Live read: an open
      // tool call, a live background task, the heavy lock (queued or holding), moving output.
      const evidence = activeEvidence({ turns: view.chatTurns ?? [], heavyLock: view.heavyLock ?? await d.heavyLock(t.row), outputMoved })
      const state = evidence ? 'working' : view.activity
      const notice = evidence ? text : `[no activity signal: no open tool call, background task, heavy-lock process or moving output; last turn ${last?.at ?? 'unknown'}]\n`
      return { ok: true, sessionId: t.row.id, leaderId: t.leader.id, observedAt: snap.polledAtMs,
        state, activeSignal: evidence?.signal ?? null,
        activityKey: createHash('sha256').update((last ? JSON.stringify([last.at, last.role, last.text, last.tools, last.pending]) : text) + `|screen:${key}` + (evidence ? `|${evidence.signal}` : '')).digest('hex'),
        // The engine keeps the LAST 2000 characters of this field, so the attribution prefix is whole and the CONTENT is what gets cut.
        lastText: evidence ? text : notice + text.slice(-Math.max(0, 2000 - notice.length)), dirty: await d.dirty(t.row.cwd),
        accountLimit: view.harness && view.lastLines && limitRuleFor(view.harness) ? detectLimit({ tail: view.lastLines, rule: limitRuleFor(view.harness), nowMs: snap.polledAtMs }) ?? false : null,
        ...(t.row.taskId ? { taskId: t.row.taskId } : {}), ...(t.row.subtaskId ? { subtaskId: t.row.subtaskId } : {}) }
    },
    'avisar-sessao-parada': async (value: unknown) => {
      const t = await target(value)
      const body = input(value).body
      if (!t || typeof body !== 'string' || !body.trim()) return refuse('a live worker, current leader and notice body are required')
      // Resolve the leader again at delivery: a handoff between observation and send must not lose the block.
      const out = await d.message(t.row.id, t.leader.id, body)
      return out.ok ? { ok: true, to: t.leader.id } : { ...refuse(out.message ?? 'the leader notice was not delivered'), code: out.code }
    },
  }
}
