/**
 * engine-delegate.ts — `EngineHostServices.fleet` delegation members (engine-api 1.7, B6.2): a native
 * session's agent may run as a managed session of ANOTHER harness, started by THIS host.
 *
 * The host's lines, each one the host's alone to hold:
 * - **Consent (superskill R2): default DENY.** A harness may be started for an agent only when the
 *   person listed it in `preferences.delegation.harnesses`. Nothing an engine sends can widen that.
 * - **Admission and the start** are the fleet's own (`runFleetSpawn`, the same door as
 *   `POST /api/fleet/new`): memory budget, PATH, spawn spec.
 * - **R1: no unfiled session.** With a `taskId`, the session is filed (`attachSession`, subtask
 *   included) right after it starts; a filing that fails STOPS the session and the start fails.
 * - **The handback** is the session's latest assistant turn, read through the chat reader.
 *
 * The functions are injected (`DelegateDeps`), so the rules are tested without a fleet.
 */
import type { EngineDelegateRefusal, EngineDelegateSpawn, EngineDelegateSpawnResult, EngineFleet, HarnessId } from '@agentistics/engine-api'

export interface DelegateDeps {
  /** Harnesses installed here (`startableHarnesses`). */
  startable(): Promise<readonly string[]>
  /** `preferences.delegation.harnesses`, read fresh each time (a person may revoke between calls). */
  allowed(): Promise<readonly string[]>
  spawn(body: { harness: string; cwd: string; prompt: string; model: string; effort?: string; label: string }): Promise<{ ok: boolean; message: string; id?: string; code?: string }>
  file(taskId: string, sessionId: string, subtaskId?: string): Promise<{ ok: boolean; reason?: string }>
  kill(id: string): Promise<void>
  chat(id: string): Promise<{ turns: Array<{ role: 'user' | 'assistant'; text: string }>; live: boolean; unavailable?: unknown }>
}

/**
 * A refusal. Built through this function rather than a `code: '…'` literal: the web's
 * notification-coverage lint reads that literal shape in server source as a notification code, and
 * these are engine-api refusal codes, never notifications.
 */
function refused(code: EngineDelegateRefusal, sentence: string): EngineDelegateSpawnResult {
  return { ok: false, code, sentence }
}

export type DelegateMembers = Required<Pick<EngineFleet, 'delegateHarnesses' | 'delegateSpawn' | 'lastReply' | 'stop'>>

export function createDelegateMembers(d: DelegateDeps): DelegateMembers {
  return {
    async delegateHarnesses() {
      const [installed, allowed] = await Promise.all([d.startable(), d.allowed()])
      return installed.filter(h => allowed.includes(h)) as HarnessId[]
    },
    async delegateSpawn(req: EngineDelegateSpawn): Promise<EngineDelegateSpawnResult> {
      const allowed = await d.allowed()
      if (!allowed.includes(req.harness)) {
        return refused('not_allowed', `You have not allowed agents to start ${req.harness} sessions; add it under Settings → Sessions → Delegation (preferences delegation.harnesses) if you want to.`)
      }
      if (!(await d.startable()).includes(req.harness)) {
        return refused('unavailable', `${req.harness} is not installed on this machine, so no session of it can start here.`)
      }
      const out = await d.spawn({
        harness: req.harness, cwd: req.cwd, prompt: req.prompt, model: req.model, label: req.label,
        ...(req.effort ? { effort: req.effort } : {}),
      })
      if (!out.ok || !out.id) {
        return refused(out.code === 'memory_budget' ? 'memory_budget' : 'refused', out.message)
      }
      if (req.taskId) {
        const filed = await d.file(req.taskId, out.id, req.subtaskId).catch(() => ({ ok: false, reason: 'error' }))
        if (!filed.ok) {
          await d.kill(out.id).catch(() => {})
          return refused('filing_failed', `The ${req.harness} session started but could not be filed on ${req.taskId} (${filed.reason ?? 'refused'}), so it was stopped: no session runs off the board.`)
        }
      }
      return { ok: true, managedId: out.id }
    },
    async lastReply(managedId) {
      try {
        const c = await d.chat(managedId)
        if (c.unavailable) return { ok: false, reason: 'unavailable' }
        const last = [...c.turns].reverse().find(t => t.role === 'assistant')
        return { ok: true, text: last?.text ?? '', live: c.live }
      } catch {
        return { ok: false, reason: 'unreadable' }
      }
    },
    async stop(managedId) {
      await d.kill(managedId).catch(() => {})
    },
  }
}

/** The real members, over the fleet's own functions, loaded on first use. */
export function hostDelegateMembers(lang: () => 'en' | 'pt'): DelegateMembers {
  const fleet = () => import('../sessions/fleet-web')
  return createDelegateMembers({
    startable: async () => {
      const host = await (await fleet()).hostForFleet(lang())
      return host.startableHarnesses ? (await host.startableHarnesses()).map(o => o.id) : []
    },
    allowed: async () => {
      const { readPreferences } = await import('../preferences')
      return (await readPreferences()).delegation?.harnesses ?? []
    },
    spawn: async body => (await fleet()).runFleetSpawn(lang(), body),
    file: async (taskId, sessionId, subtaskId) => {
      const r = await (await import('../sessions/task-web')).attachSession(taskId, sessionId, subtaskId ? { subtaskId } : {})
      return r.ok ? { ok: true } : { ok: false, reason: r.reason }
    },
    kill: async id => { await (await fleet()).runFleetAction(lang(), { id, action: 'kill' }) },
    chat: async id => {
      const f = await fleet()
      const { readSessionChat } = await import('../sessions/chat-web')
      return readSessionChat(await f.hostForFleet(lang()), lang(), id)
    },
  })
}
