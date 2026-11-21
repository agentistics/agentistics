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
 *
 * THE DIALOG IS RE-READ RIGHT BEFORE THE KEYSTROKE (M1). The poll's snapshot can be up to a poll old, so
 * the runner captures the pane itself (`capture`, ANSI kept — the old layout's description is told apart
 * by its dim attribute), decides on THAT frame, and hands the host the dialog's identity
 * (`noqDialogKey`): the host compares it against the frame it reads immediately before typing and
 * refuses when it differs. A refusal of that kind is re-captured and re-judged at once (bounded).
 * The same dialog still on screen after `NOQ_REPEAT_MS` is answered again (M2: a keystroke that did not
 * land, or the identical question asked twice between two polls) — never sooner.
 */
import { appendFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { SessionSnapshot } from './sessions-host'
import { decideNoqAnswer, noqDialogKey, noteAnswerResult, shouldAnswer, type NoqDecision, type NoqMemory } from './noq-policy'

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
  /**
   * Type the option — ONLY if the dialog on the pane, read immediately before the keystroke, still has
   * identity `expectKey`. `stale: true` = it did not (nothing was typed).
   */
  answer(id: string, choice: number, expectKey: string): Promise<{ ok: boolean; message: string; stale?: boolean }>
  /** A fresh capture of the pane (ANSI allowed), or null. Without it the snapshot's lines are used. */
  capture?(id: string): Promise<string[] | null>
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
        let d: NoqDecision = { action: 'skip', why: 'unread' }
        let out: { ok: boolean; message: string; stale?: boolean } = { ok: false, message: '' }
        let answered = false
        for (let attempt = 0; attempt < 2; attempt++) {
          const frame = (await deps.capture?.(v.id).catch(() => null)) ?? v.approvalLines ?? []
          d = decideNoqAnswer({
            harness: v.harness, mode, cwd: v.cwd, frame, dialogOptions: v.dialogOptions,
          }, { home: deps.home ?? '/root' })
          if (d.action === 'skip') break
          const key = noqDialogKey(frame) || frame.join('\n')
          if (attempt === 0 && !shouldAnswer(mem, v.id, key, now())) break
          if (attempt > 0) mem.lastKey.set(v.id, { key, atMs: now(), ok: false })
          out = await deps.answer(v.id, d.choice, key).catch((e: unknown) => ({ ok: false, message: String(e) }))
          noteAnswerResult(mem, v.id, out.ok)
          answered = true
          if (!out.stale) break
        }
        if (!answered || d.action === 'skip' || out.stale) continue
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
  const { resolveBackend } = await import('./index')
  const host = await hostForFleet('en')
  const file = join(AGENTISTICS_DATA_DIR, 'noq-answers.jsonl')
  return {
    home: HOME_DIR,
    registryMode: async id => (await (await import('./registry')).readRegistry()).find(m => m.id === id)?.mode,
    log: m => console.warn(m),
    capture: async id => (await (await resolveBackend()).captureTerminal(id, 60).catch(() => null))?.lines ?? null,
    answer: async (id, choice, expectKey) => {
      if (!host.answerSession) return { ok: false, message: 'no host' }
      let stale = false
      const r = await host.answerSession(id, choice, '', undefined, frame => {
        stale = noqDialogKey(frame) !== expectKey
        return !stale
      })
      if (r.ok) (await import('../engine/fleet-hub')).fleetHub.noteAnswered(id, choice)
      return { ...r, stale }
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
