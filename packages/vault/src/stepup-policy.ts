/**
 * stepup-policy.ts — the authenticator GATE's decisions (SECRETS.4 §2). PURE: clock and seed injected.
 *
 * TOTP is a gate, never a cipher key (§2.1, §9.1): nothing is derived from the seed or a code. It
 * decides whether a request is ALLOWED; presence / recovery / passphrase decide whether the DEK CAN
 * open.
 *
 *  - window ±1 step; a code within ±20 steps but outside ±1 is refused as `stepup-clock` with how far
 *    off the clock is (a wrong clock is not the user's typo);
 *  - replay: the last ACCEPTED step is kept; a code for a step ≤ it is `stepup-replayed`;
 *  - attempts (§2.3): failures 1–4 refused with no delay; the 5th pauses 30 s, doubling at each further
 *    failure, capped at 15 min; the 20th FREEZES the gate until `agentop vault recover`;
 *  - a success resets the counter;
 *  - the state is kept on disk AND in memory, and the LARGER of the two wins (`mergeStepUpState`), so
 *    neither a restart nor an older file lowers the count.
 */
import { matchTotp, skewStepsOf } from './totp'

export const STEPUP_WINDOW = 1
export const STEPUP_SKEW_WINDOW = 20
export const PAUSE_AFTER = 5
export const FREEZE_AT = 20
export const FIRST_PAUSE_MS = 30_000
export const MAX_PAUSE_MS = 15 * 60_000

export interface StepUpState {
  v: 1
  failures: number
  /** The TOTP counter of the last accepted code; null before the first. */
  lastStep: number | null
  pausedUntilMs: number | null
  frozen: boolean
}

export const FRESH_STEPUP: StepUpState = Object.freeze({ v: 1, failures: 0, lastStep: null, pausedUntilMs: null, frozen: false }) as StepUpState

/** PURE. Parse `stepup.json`; junk reads as FRESH only if the memory copy is merged on top (never alone lower). */
export function parseStepUpState(raw: string | null): StepUpState | null {
  if (raw === null) return null
  try {
    const o = JSON.parse(raw) as Partial<StepUpState>
    if (o.v !== 1) return null
    const n = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) && x >= 0 ? Math.floor(x) : null)
    return { v: 1, failures: n(o.failures) ?? 0, lastStep: n(o.lastStep), pausedUntilMs: n(o.pausedUntilMs), frozen: o.frozen === true }
  } catch { return null }
}

const maxN = (a: number | null, b: number | null) => (a === null ? b : b === null ? a : Math.max(a, b))

/** PURE. The larger of the two wins on every field — a file older than memory never lowers anything. */
export function mergeStepUpState(a: StepUpState | null, b: StepUpState | null): StepUpState {
  const x = a ?? FRESH_STEPUP
  const y = b ?? FRESH_STEPUP
  return {
    v: 1,
    failures: Math.max(x.failures, y.failures),
    lastStep: maxN(x.lastStep, y.lastStep),
    pausedUntilMs: maxN(x.pausedUntilMs, y.pausedUntilMs),
    frozen: x.frozen || y.frozen,
  }
}

/** PURE. The pause after `failures` consecutive failures (0 when none applies). */
export function pauseFor(failures: number): number {
  if (failures < PAUSE_AFTER) return 0
  return Math.min(FIRST_PAUSE_MS * 2 ** (failures - PAUSE_AFTER), MAX_PAUSE_MS)
}

export type GateBlock = { code: 'stepup-frozen' } | { code: 'stepup-paused'; untilMs: number }

/** PURE. May an attempt be made at all right now? */
export function attemptBlocked(s: StepUpState, nowMs: number): GateBlock | null {
  if (s.frozen) return { code: 'stepup-frozen' }
  if (s.pausedUntilMs !== null && nowMs < s.pausedUntilMs) return { code: 'stepup-paused', untilMs: s.pausedUntilMs }
  return null
}

/** PURE. The state after one failed attempt. */
export function afterFailure(s: StepUpState, nowMs: number): StepUpState {
  const failures = s.failures + 1
  if (failures >= FREEZE_AT) return { ...s, failures, frozen: true, pausedUntilMs: null }
  const p = pauseFor(failures)
  return { ...s, failures, pausedUntilMs: p ? nowMs + p : null }
}

/** PURE. The state after an accepted code for `step`. */
export function afterSuccess(s: StepUpState, step: number): StepUpState {
  return { v: 1, failures: 0, lastStep: maxN(s.lastStep, step), pausedUntilMs: null, frozen: false }
}

export type StepUpVerdict =
  | { ok: true; step: number; state: StepUpState }
  | { ok: false; code: 'stepup-frozen'; state: StepUpState }
  | { ok: false; code: 'stepup-paused'; untilMs: number; state: StepUpState }
  | { ok: false; code: 'stepup-replayed'; state: StepUpState }
  /** `skewSteps` is how far off the clock is (positive = the code is from the future). */
  | { ok: false; code: 'stepup-clock'; skewSteps: number; state: StepUpState }
  /** `left` = tries before the first pause (0 when already pausing). */
  | { ok: false; code: 'stepup-wrong'; left: number; state: StepUpState }

/**
 * PURE. Judge one code against the seed. The seed is only READ here; the caller opened it and zeroes
 * it. A clock-skewed or replayed code COUNTS as a failure: otherwise a guesser could probe the ±20
 * window, or replay, for free.
 */
export function judgeCode(seed: Uint8Array, code: string, nowMs: number, s: StepUpState): StepUpVerdict {
  const blocked = attemptBlocked(s, nowMs)
  if (blocked) return blocked.code === 'stepup-frozen' ? { ok: false, code: 'stepup-frozen', state: s } : { ok: false, code: 'stepup-paused', untilMs: blocked.untilMs, state: s }
  const nowSec = Math.floor(nowMs / 1000)
  const step = matchTotp(seed, code, nowSec, STEPUP_WINDOW)
  if (step !== null) {
    if (s.lastStep !== null && step <= s.lastStep) return { ok: false, code: 'stepup-replayed', state: afterFailure(s, nowMs) }
    return { ok: true, step, state: afterSuccess(s, step) }
  }
  const failed = afterFailure(s, nowMs)
  const skew = skewStepsOf(seed, code, nowSec, STEPUP_SKEW_WINDOW)
  if (failed.frozen) return { ok: false, code: 'stepup-frozen', state: failed }
  if (skew !== null && Math.abs(skew) > STEPUP_WINDOW) return { ok: false, code: 'stepup-clock', skewSteps: skew, state: failed }
  return { ok: false, code: 'stepup-wrong', left: Math.max(0, PAUSE_AFTER - failed.failures), state: failed }
}

/** PURE. "{n} minutes earlier/later" for the clock sentence. */
export function skewWords(skewSteps: number, lang: 'en' | 'pt'): { n: number; direction: string } {
  const n = Math.max(1, Math.round(Math.abs(skewSteps) * 30 / 60))
  const future = skewSteps > 0
  return { n, direction: lang === 'pt' ? (future ? 'adiantado' : 'atrasado') : (future ? 'later' : 'earlier') }
}

/** PURE. A pause as words: "30 seconds", "2 minutes". */
export function durationWords(ms: number, lang: 'en' | 'pt'): string {
  const s = Math.max(1, Math.ceil(ms / 1000))
  if (s < 90) return lang === 'pt' ? `${s} segundos` : `${s} seconds`
  const m = Math.ceil(s / 60)
  return lang === 'pt' ? `${m} minutos` : `${m} minutes`
}
