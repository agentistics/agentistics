/**
 * noq-runner.ts — the IO half of `noq-policy.ts`: answers a no-questions session's permission prompt.
 *
 * Attached to the server's ONE fleet hub (`events/daemon.ts`). For each row whose dialog the policy
 * decides, it answers through the host (`answerSession`, which re-reads the screen first), records the
 * answer in `noq-answers.jsonl` + a notification (never silent), and — for a refusal — types the reason
 * for the model once the dialog has closed. Sessions outside no-questions are not touched.
 */
import { appendFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { SessionSnapshot } from './sessions-host'
import { decideNoqAnswer, shouldAnswer, type NoqDecision, type NoqMemory } from './noq-policy'

export interface NoqAnswerRecord {
  at: string
  id: string
  command: string
  decision: 'approve' | 'deny'
  choice: number
  rule: string
  reason: string
  ok: boolean
  message: string
}

export interface NoqDeps {
  answer(id: string, choice: number): Promise<{ ok: boolean; message: string }>
  prompt(id: string, text: string): Promise<{ ok: boolean; message: string }>
  record(r: NoqAnswerRecord): Promise<void> | void
  /** The mode the session was STARTED in (registry). A permission dialog's footer hides the mode chip, so the frame often cannot say. */
  startMode?(id: string): Promise<string | undefined>
  now?: () => number
  home?: string
  sleep?: (ms: number) => Promise<void>
}

export function createNoqRunner(deps: NoqDeps) {
  const mem: NoqMemory = { lastKey: new Map() }
  const now = deps.now ?? Date.now
  const sleep = deps.sleep ?? (ms => new Promise<void>(r => setTimeout(r, ms)))
  return {
    /** One poll's rows. Resolves when every answer of this poll has been sent and recorded. */
    async consume(snap: SessionSnapshot): Promise<NoqAnswerRecord[]> {
      const done: NoqAnswerRecord[] = []
      for (const v of snap.sessions) {
        if (v.activity !== 'waiting-approval') continue
        const mode = v.mode?.canonical ?? await deps.startMode?.(v.id).catch(() => undefined)
        const d: NoqDecision = decideNoqAnswer({
          harness: v.harness, mode, cwd: v.cwd,
          approvalLines: v.approvalLines, dialogOptions: v.dialogOptions,
        }, deps.home)
        if (d.action === 'skip') continue
        if (!shouldAnswer(mem, v.id, (v.approvalLines ?? []).join('\n'), now())) continue
        const out = await deps.answer(v.id, d.choice).catch((e: unknown) => ({ ok: false, message: String(e) }))
        const rec: NoqAnswerRecord = {
          at: new Date(now()).toISOString(), id: v.id, command: d.command, decision: d.action,
          choice: d.choice, rule: d.rule, reason: d.reason, ok: out.ok, message: out.message,
        }
        if (out.ok && d.action === 'deny') {
          await sleep(1500)
          await deps.prompt(v.id, d.reason).catch(() => undefined)
        }
        await Promise.resolve(deps.record(rec)).catch(() => undefined)
        done.push(rec)
      }
      return done
    },
  }
}

/** The production wiring: the fleet's own host, a JSONL beside the other data, and a bell notice. */
export async function defaultNoqDeps(): Promise<NoqDeps> {
  const { hostForFleet } = await import('./fleet-web')
  const { AGENTISTICS_DATA_DIR, HOME_DIR } = await import('../config')
  const { broadcastNotification } = await import('../sse')
  const host = await hostForFleet('en')
  const file = join(AGENTISTICS_DATA_DIR, 'noq-answers.jsonl')
  return {
    home: HOME_DIR,
    startMode: async id => (await (await import('./registry')).readRegistry()).find(m => m.id === id)?.mode,
    answer: async (id, choice) => {
      if (!host.answerSession) return { ok: false, message: 'no host' }
      const r = await host.answerSession(id, choice, '')
      if (r.ok) (await import('../engine/fleet-hub')).fleetHub.noteAnswered(id, choice)
      return r
    },
    prompt: async (id, text) => host.promptSession ? host.promptSession(id, text) : { ok: false, message: 'no host' },
    record: async r => {
      await appendFile(file, JSON.stringify(r) + '\n', { mode: 0o600 })
      broadcastNotification({
        type: r.decision === 'approve' ? 'info' : 'warning',
        title: `Autonomous session ${r.id.slice(0, 8)}: ${r.decision === 'approve' ? 'approved' : 'refused'} a permission prompt`,
        message: `${r.command.slice(0, 200)} — ${r.reason}`,
      })
    },
  }
}
