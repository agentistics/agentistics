/**
 * updateAnim.ts — PURE rules behind the update animations (`updateScene.ts` draws them).
 *
 * Kept out of the canvas code so every number that decides what a person SEES is a tested function:
 * which animation is in force, how a displayed value eases toward a target, how the download is
 * estimated BETWEEN server polls, what the scene is asked to show for each real step, and what the
 * logo may do. Nothing here touches the DOM, a clock or a canvas.
 */

import type { UpdateStep } from './updateI18n'

export type UpdateAnimation = 'core' | 'hive'

// ---- easing -------------------------------------------------------------------------------------

/** Time constant of the displayed value's approach to its target, in ms. */
export const EASE_TAU_MS = 220

/** Frame-rate independent ease: the same feel at 30, 60 or 144 fps, and never a jump. */
export function easeFactor(dtMs: number, tauMs = EASE_TAU_MS): number {
  return 1 - Math.exp(-Math.max(0, dtMs) / tauMs)
}

export function easeToward(shown: number, target: number, dtMs: number, tauMs = EASE_TAU_MS): number {
  return shown + (target - shown) * easeFactor(dtMs, tauMs)
}

export const clamp01 = (x: number): number => Math.max(0, Math.min(1, x))

// ---- download estimation between polls ----------------------------------------------------------

export interface ByteSample { received: number; total: number; at: number }

/**
 * Bytes per second from two consecutive real samples, smoothed with the previous rate so one odd
 * poll does not swing the estimate. `null` until two samples exist or when time did not advance.
 */
export function measureRate(prev: ByteSample | null, next: ByteSample, prevRate: number | null): number | null {
  if (!prev || next.at <= prev.at) return prevRate
  const inst = Math.max(0, (next.received - prev.received) / ((next.at - prev.at) / 1000))
  return prevRate === null ? inst : prevRate * 0.5 + inst * 0.5
}

/**
 * The download fraction to DISPLAY now: the last real value, advanced by the measured rate for the
 * time since it arrived — but never past that value plus ONE poll's worth of bytes (a stalled
 * download must stop, not run ahead on a stale rate), and never past the total.
 */
export function estimateDownload(last: ByteSample | null, rate: number | null, now: number, pollMs: number): number {
  if (!last || !(last.total > 0)) return 0
  const real = clamp01(last.received / last.total)
  if (rate === null || rate <= 0) return real
  const elapsed = Math.max(0, Math.min(now - last.at, pollMs))
  const bytes = Math.min(rate * elapsed / 1000, rate * pollMs / 1000)
  return clamp01(Math.min((last.received + bytes) / last.total, 1))
}

// ---- what the scene is asked to show ------------------------------------------------------------

export interface SceneTarget {
  /** Which of the four narrated steps is current (0..3). */
  i: number
  /** Fill of the current step's bar (0..1). */
  frac: number
  /** Overall progress (0..1) the scene eases toward. */
  p: number
  /** The restart: no percentage exists, so nothing here claims one. */
  indet: boolean
}

/** Overall progress at the end of the download, and where the indeterminate restart creeps to. */
export const DOWNLOAD_SHARE = 0.55
export const RESTART_FLOOR = 0.72
export const RESTART_CAP = 0.86

/**
 * The target for a real step. `download` is the (estimated) download fraction; `sinceStepMs` is how
 * long the current step has lasted — the restart creeps with it, capped, and ends only when the
 * server reports the target version (the step becomes `power`).
 */
export function sceneTarget(step: UpdateStep, download: number | undefined, sinceStepMs: number, brainFrac = 0.5): SceneTarget {
  switch (step) {
    case 'data': {
      const d = download === undefined ? 0.02 : clamp01(download)
      return { i: 0, frac: d, p: Math.max(0.01, DOWNLOAD_SHARE * d), indet: false }
    }
    case 'brain': {
      const f = clamp01(brainFrac)
      return { i: 1, frac: 0.35 + 0.45 * f, p: 0.6 + 0.08 * f, indet: false }
    }
    case 'wiring': {
      const t = Math.max(0, sinceStepMs) / 1000
      return { i: 2, frac: 0, p: Math.min(RESTART_CAP, RESTART_FLOOR + (RESTART_CAP - RESTART_FLOOR) * (1 - Math.exp(-t / 4))), indet: true }
    }
    case 'power': {
      const fr = clamp01(sinceStepMs / 1500)
      return { i: 3, frac: fr, p: 0.88 + 0.12 * fr, indet: false }
    }
  }
}

// ---- the logo -----------------------------------------------------------------------------------

/** The ONLY things the logo may change (owner rule): size, opacity and glow — never its geometry. */
export interface LogoPose { scale: number; alpha: number; glow: number }

/** Seconds the scene takes to be pulled into the mark. */
export const SUCK_S = 1.25

const easeOut3 = (x: number) => 1 - Math.pow(1 - clamp01(x), 3)

export function runningLogoPose(p: number, indet: boolean, nowMs: number, reduced: boolean): LogoPose {
  const breathe = indet && !reduced ? 0.5 + 0.5 * Math.sin(nowMs / 520) : 1
  return { scale: 0.94 + 0.06 * p, alpha: 0.88 + 0.12 * p, glow: (0.15 + 0.6 * p) * breathe }
}

/** The mark takes the scene in: it swells while absorbing, then settles after the burst. */
export function finaleLogoPose(finT: number, reduced: boolean): LogoPose {
  const absorb = clamp01(finT / SUCK_S), after = finT - SUCK_S
  const scale = reduced ? 1 : after < 0 ? 1 + 0.08 * absorb : 1.08 + 0.06 * Math.sin(Math.min(1, after / 0.35) * Math.PI) - 0.08 * easeOut3(after / 0.6)
  return { scale, alpha: 1, glow: 0.4 + 0.9 * absorb }
}

// ---- the finale's timeline ----------------------------------------------------------------------

export interface FinaleBeat {
  /** 0..1: how much of the scene has been pulled into the mark. */
  absorb: number
  /** Seconds since the suction ended (negative before). */
  after: number
  /** The burst (flash + sparks) starts. */
  burst: boolean
  /** Header and step text have left (they fade the instant the burst begins). */
  chromeGone: boolean
  /** The result text may appear — only after the step text has faded out. */
  textIn: boolean
}

export const BURST_CHROME_FADE_S = 0.05
export const RESULT_TEXT_DELAY_S = 0.6

export function finaleBeat(finT: number): FinaleBeat {
  const after = finT - SUCK_S
  return { absorb: clamp01(finT / SUCK_S), after, burst: after > 0, chromeGone: after > BURST_CHROME_FADE_S, textIn: after > RESULT_TEXT_DELAY_S }
}

/** Where the finale stands for a reduced-motion reader: everything settled, nothing travelling. */
export const REDUCED_FINALE_BEAT: FinaleBeat = { absorb: 1, after: 10, burst: false, chromeGone: true, textIn: true }
