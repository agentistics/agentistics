/**
 * upgradeSteps.ts — PURE: which narrated loader step an in-flight upgrade is on, read from REAL
 * signals only.
 *
 * Three signals exist and each is a fact, never a timer:
 *  - what the detached `agentop upgrade` wrote about itself (`GET /api/upgrade/status`, see
 *    `server/upgrade-progress.ts`): checking / downloading (+bytes) / verifying / swapping /
 *    restarting / done / failed;
 *  - whether the server answered at all — an upgrade restarts the very process serving this page,
 *    so silence AFTER the press is the restart happening. One dropped poll mid-download is a
 *    hiccup, not a restart, so silence counts only after two quiet polls in a row — or one, once
 *    the binary is already being swapped (`QUIET_POLLS_FOR_RESTART`);
 *  - whether `/api/version` names the target (`upgradeArrived`), which is the final word.
 *
 * The four steps the loader narrates map onto them:
 *   data   ← checking, downloading           (the bar follows bytes when GitHub sent a length)
 *   brain  ← verifying, swapping
 *   wiring ← restarting, or the server gone quiet
 *   power  ← `/api/version` back on the target
 *
 * The step NEVER goes backwards (`advance`): a poll that lands on the old server a beat before it
 * is killed must not rewind the narration a person is reading. A progress record written BEFORE
 * this press (a previous run's `done`, say) is ignored — it describes some other upgrade.
 */

import { UPDATE_STEPS, type UpdateStep } from './updateI18n'
import type { UpdateAnimation } from './updateAnim'

/**
 * WHICH update animation plays. Both ship (`core` = "Núcleo", `hive` = "Colmeia"); there is NO
 * user-facing choice (owner, 2026-10-02) — this one constant picks, and the owner switches it on
 * request. `updateAnim.test.ts` pins the default to `core` and renders both paths so the other
 * never rots.
 */
export const UPDATE_ANIMATION: UpdateAnimation = 'core'

export type ServerStage = 'checking' | 'downloading' | 'verifying' | 'swapping' | 'restarting' | 'done' | 'failed'

export interface ServerProgress {
  stage: ServerStage
  version: string
  received?: number
  total?: number
  at: number
}

export interface StepInput {
  /** When the page pressed install (epoch ms). */
  startedAt: number
  /** The last progress record the server returned, or null. */
  progress: ServerProgress | null
  /** Consecutive polls that got no answer at all (0 = the last one answered). */
  quietPolls: number
  /** Has `/api/version` come back naming the target? */
  arrived: boolean
}

export interface StepView {
  step: UpdateStep
  /** 0..1 across the whole upgrade, for the core's charge level. Monotone with `step`. */
  fraction: number
  /** 0..1 inside the download, only when bytes and a total are both known. */
  download?: number
  failed: boolean
}

/** A record stamped this long before the press still counts — clock skew between tab and server. */
export const PROGRESS_SKEW_MS = 5_000

/** Quiet polls in a row before silence is read as the restart (one, once the swap has begun). */
export const QUIET_POLLS_FOR_RESTART = 2

/** Where each step starts on the overall 0..1 charge. The download is the long one. */
const STEP_START: Record<UpdateStep, number> = { data: 0, brain: 0.55, wiring: 0.72, power: 0.92 }
const STEP_END: Record<UpdateStep, number> = { data: 0.55, brain: 0.72, wiring: 0.92, power: 1 }

const STAGE_STEP: Record<Exclude<ServerStage, 'failed' | 'done'>, UpdateStep> = {
  checking: 'data', downloading: 'data', verifying: 'brain', swapping: 'brain', restarting: 'wiring',
}

export function stepIndex(s: UpdateStep): number { return UPDATE_STEPS.indexOf(s) }

/** Where the signals put the upgrade right now, before the never-backwards rule. */
export function rawStep(i: StepInput): StepView {
  if (i.arrived) return { step: 'power', fraction: 1, failed: false }
  const p = i.progress && i.progress.at >= i.startedAt - PROGRESS_SKEW_MS ? i.progress : null
  if (p?.stage === 'failed') return { step: 'data', fraction: 0, failed: true }
  // `done` without the version arriving yet: the binary is in and the services were bounced, so
  // what is left is the server answering — the same place as "restarting".
  if (p?.stage === 'done') return { step: 'wiring', fraction: STEP_START.wiring + 0.1, failed: false }
  // Quiet after the press: the old process was killed by the restart. That is progress, not error.
  const late = p?.stage === 'swapping' || p?.stage === 'restarting'
  if (i.quietPolls >= (late ? 1 : QUIET_POLLS_FOR_RESTART)) {
    const from = p ? STAGE_STEP[p.stage] : 'data'
    return stepIndex(from) >= stepIndex('wiring')
      ? { step: from, fraction: STEP_START[from] + 0.05, failed: false }
      : { step: 'wiring', fraction: STEP_START.wiring + 0.05, failed: false }
  }
  if (!p) return { step: 'data', fraction: 0.02, failed: false }
  const step = STAGE_STEP[p.stage]
  if (p.stage === 'downloading' && p.total && p.received !== undefined) {
    const d = Math.max(0, Math.min(1, p.received / p.total))
    return { step, fraction: STEP_START.data + 0.05 + d * (STEP_END.data - STEP_START.data - 0.05), download: d, failed: false }
  }
  const within = p.stage === 'swapping' || p.stage === 'downloading' ? 0.5 : 0.1
  return { step, fraction: STEP_START[step] + within * (STEP_END[step] - STEP_START[step]), failed: false }
}

/**
 * Never backwards: the later step wins, and inside one step the larger charge wins. A failure is
 * always reported — it is the one signal that must not be smoothed over.
 */
export function advance(prev: StepView | null, next: StepView): StepView {
  if (next.failed || !prev) return next
  const a = stepIndex(prev.step), b = stepIndex(next.step)
  if (b > a) return next
  if (b < a) return prev
  return next.fraction >= prev.fraction ? next : { ...next, fraction: prev.fraction }
}
