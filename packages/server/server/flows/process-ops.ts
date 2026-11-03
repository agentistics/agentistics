/**
 * flows/process-ops.ts — the host ops behind the `coletor-processos` flow (engine `flows/coletor.ts`).
 *
 *  - `coletar-processos` {dryRun?, graceMs?} — ONE collector pass: every process still carrying the
 *    marker of a session the registry says ENDED (more than `graceMs` ago, default 2 min), that the
 *    backend does not list as alive, and that started before the session ended, is stopped (TERM, grace,
 *    KILL). The rules live in `sessions/session-reaper.ts`; this is only the door the flow comes through.
 *  - `matar-arvore-sessao` {sessionId, dryRun?} — the same, for ONE ended session, now (no grace).
 *    Refused for a session that is not ended or that the backend still lists as alive: ending a LIVE
 *    session is `encerrar-sessao`'s job (the fleet's kill verb), which stops the tree itself — so
 *    fechar-entregue, the leader's retire and `agentop session kill` all end in the same stop.
 *
 * Answers carry what was FOUND, what was STOPPED and the MB freed, so the run record in `flows/runs`
 * says it. A refusal is `{refused, reason, missing}`, the host-op convention.
 */
import { collectorPass, stopSessionProcesses } from '../sessions/session-reaper-io'
import { reapSentence } from '../sessions/session-reaper'

type Refusal = { refused: true; reason: string; missing: string[] }
const refuse = (reason: string, missing: string[] = []): Refusal => ({ refused: true, reason, missing })
const rec = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {})
const dryOf = (i: Record<string, unknown>) => i.dryRun === true || i['dry-run'] === true
const mb = (b: number) => Math.round(b / (1024 * 1024))

export interface ProcessOpsDeps {
  collect: typeof collectorPass
  stopOne: typeof stopSessionProcesses
  /** The registry's `endedAt` for `id` (ms), or null when not ended / unknown. */
  endedAt(id: string): Promise<number | null>
  /** Is `id` listed alive by the backend? `null` = could not be listed. */
  alive(id: string): Promise<boolean | null>
}

export function defaultProcessOpsDeps(): ProcessOpsDeps {
  return {
    collect: collectorPass,
    stopOne: stopSessionProcesses,
    async endedAt(id) {
      const row = (await (await import('../sessions/registry')).readRegistry()).find(r => r.id === id)
      const t = row?.endedAt ? Date.parse(row.endedAt) : Number.NaN
      return Number.isFinite(t) ? t : null
    },
    async alive(id) {
      try {
        const b = await (await import('../sessions/index')).resolveBackend()
        if (await b.unavailable()) return null
        return (await b.list()).some(s => s.id === id && s.alive !== false)
      } catch { return null }
    },
  }
}

export function processHostOps(deps: ProcessOpsDeps = defaultProcessOpsDeps()) {
  return {
    'coletar-processos': async (value: unknown) => {
      const i = rec(value)
      const graceMs = typeof i.graceMs === 'number' && Number.isFinite(i.graceMs) && i.graceMs >= 0 ? i.graceMs : undefined
      const r = await deps.collect({ dryRun: dryOf(i), ...(graceMs !== undefined ? { graceMs } : {}) })
      if (r.skippedWhy && r.skippedWhy !== 'nothing carries a session marker') return refuse(`the collector could not judge: ${r.skippedWhy}`, ['readable /proc, registry and backend'])
      return {
        ok: true, dryRun: r.dryRun,
        found: r.found ?? [], foundCount: (r.found ?? []).length,
        stopped: r.pids, stoppedCount: r.processes, stuck: r.stuck,
        sessions: r.sessions, freedBytes: r.freedBytes, freedMb: mb(r.freedBytes),
        summary: reapSentence(r),
      }
    },
    'matar-arvore-sessao': async (value: unknown) => {
      const i = rec(value)
      const id = typeof i.sessionId === 'string' && i.sessionId ? i.sessionId : typeof i.session === 'string' && i.session ? i.session : null
      if (!id) return refuse('session id is required', ['sessionId'])
      const endedMs = await deps.endedAt(id)
      if (endedMs === null) return refuse(`session ${id} is not ended — end it first (encerrar-sessao), which stops its tree`, ['ended session'])
      const alive = await deps.alive(id)
      if (alive === null) return refuse('the session backend could not be listed', ['listable backend'])
      if (alive) return refuse(`session ${id} is still running — encerrar-sessao ends it`, ['session not running'])
      const dryRun = dryOf(i)
      const r = await deps.stopOne(id, { endedMs, dryRun })
      return {
        ok: r.stuck.length === 0, dryRun, sessionId: id,
        found: r.found, foundCount: r.found.length,
        stopped: r.stopped, stoppedCount: r.stopped.length, stuck: r.stuck,
        freedBytes: r.freedBytes, freedMb: mb(r.freedBytes),
        summary: reapSentence({ freedBytes: r.freedBytes, processes: dryRun ? r.found.length : r.stopped.length, dryRun }),
      }
    },
  }
}
