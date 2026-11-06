/** IO for sessao-parada. The engine owns episodes, timers, handbacks and delivery cadence. */
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { gitEnv } from '../backup/repo-probe'
import { detectLimit, limitRuleFor } from '../sessions/limit'
import { currentLeaderId } from '../sessions/team-links'
import type { ManagedSession } from '../sessions/types'
import type { SessionSnapshot } from '../sessions/sessions-host'
import { defaultMessageDeps, sendSessionMessage } from '../sessions/session-message'

const exec = promisify(execFile)
const refuse = (reason: string) => ({ refused: true, reason, missing: ['fresh managed worker observation'] })
const input = (v: unknown): Record<string, unknown> => v && typeof v === 'object' ? v as Record<string, unknown> : {}

export interface StalledHostDeps {
  registry(): Promise<readonly ManagedSession[]>
  snapshot(): Promise<Pick<SessionSnapshot, 'sessions' | 'polledAtMs' | 'unavailable'>>
  role(row: ManagedSession): Promise<string | undefined>
  dirty(cwd: string): Promise<boolean | null>
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
    message: async (from, to, body) => sendSessionMessage(from, { to, body, kind: 'block' }, await defaultMessageDeps()),
    now: Date.now,
  }
}

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
      if (!view || !['waiting', 'waiting-approval', 'working'].includes(view.activity ?? '') || ['closed', 'lost'].includes(view.status)) return refuse('the worker has no live activity reading')
      const last = view.chatTurns?.at(-1)
      // Prefer transcript content: screen footers may repaint clocks without any agent activity.
      const text = (last?.text ?? view.lastLines?.join('\n') ?? '').slice(-2000)
      return { ok: true, sessionId: t.row.id, leaderId: t.leader.id, observedAt: snap.polledAtMs,
        state: view.activity, activityKey: createHash('sha256').update(last ? JSON.stringify([last.at, last.role, last.text, last.tools, last.pending]) : text).digest('hex'),
        lastText: text, dirty: await d.dirty(t.row.cwd),
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
