/**
 * noq-runner.ts — the IO half of `noq-policy.ts`: answers a no-questions session's permission prompt.
 *
 * Attached to the server's ONE fleet hub (`events/daemon.ts`). For each row whose dialog the policy
 * decides, it answers through the host (`answerSession`, which re-reads the screen first) and records the
 * answer in `noq-answers.jsonl` + a notification (never silent). A refusal's reason is typed for the model
 * only on a LATER poll, once the row no longer shows a dialog — never blind after a timer.
 *
 * THE MODE must be the session's CURRENT one: the live chip, else the last chip this runner SAW for the
 * row, else the registry's recorded (chip-set) mode. The mode a session STARTED in is not enough — a
 * person may have cycled it to `default` since — and an unknown mode is left to the person (logged once).
 * A dialog already answered successfully is never answered again; only a new frame is evaluated.
 */
import { appendFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { SessionSnapshot } from './sessions-host'
import { decideNoqAnswer, noteAnswerResult, shouldAnswer, type NoqDecision, type NoqMemory } from './noq-policy'

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
  /** The registry's CURRENT mode for the row (what the chip last set). Never the start mode alone. */
  registryMode?(id: string): Promise<string | undefined>
  /** Diagnostics (an unknown mode is logged once per session). */
  log?(message: string): void
  now?: () => number
  home?: string
}

const PENDING_MS = 120_000

export function createNoqRunner(deps: NoqDeps) {
  const mem: NoqMemory = { lastKey: new Map() }
  const seenMode = new Map<string, string>()
  const pending = new Map<string, { text: string; atMs: number }>()
  const warned = new Set<string>()
  const now = deps.now ?? Date.now
  return {
    /** One poll's rows. Resolves when every answer of this poll has been sent and recorded. */
    async consume(snap: SessionSnapshot): Promise<NoqAnswerRecord[]> {
      const done: NoqAnswerRecord[] = []
      const live = new Set<string>()
      for (const v of snap.sessions) {
        live.add(v.id)
        const chip = v.mode?.canonical
        if (chip) seenMode.set(v.id, chip)
        if (v.activity !== 'waiting-approval') {
          mem.lastKey.delete(v.id)
          const p = pending.get(v.id)
          if (p) {
            pending.delete(v.id)
            if (now() - p.atMs < PENDING_MS) await deps.prompt(v.id, p.text).catch(() => undefined)
          }
          continue
        }
        const mode = chip ?? seenMode.get(v.id) ?? await deps.registryMode?.(v.id).catch(() => undefined)
        if (!mode) {
          if (!warned.has(v.id)) { warned.add(v.id); deps.log?.(`noq: ${v.id.slice(0, 8)} shows a dialog and its current mode is unknown; left to the person`) }
          continue
        }
        const d: NoqDecision = decideNoqAnswer({
          harness: v.harness, mode, cwd: v.cwd,
          approvalLines: v.approvalLines, dialogOptions: v.dialogOptions,
        }, deps.home)
        if (d.action === 'skip') continue
        if (!shouldAnswer(mem, v.id, (v.approvalLines ?? []).join('\n'), now())) continue
        const out = await deps.answer(v.id, d.choice).catch((e: unknown) => ({ ok: false, message: String(e) }))
        noteAnswerResult(mem, v.id, out.ok)
        const rec: NoqAnswerRecord = {
          at: new Date(now()).toISOString(), id: v.id, command: d.command, decision: d.action,
          choice: d.choice, rule: d.rule, reason: d.reason, ok: out.ok, message: out.message,
        }
        if (out.ok && d.action === 'deny') pending.set(v.id, { text: d.reason, atMs: now() })
        await Promise.resolve(deps.record(rec)).catch(() => undefined)
        done.push(rec)
      }
      for (const id of [...pending.keys()]) if (!live.has(id)) pending.delete(id)
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
    registryMode: async id => (await (await import('./registry')).readRegistry()).find(m => m.id === id)?.mode,
    log: m => console.warn(m),
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
