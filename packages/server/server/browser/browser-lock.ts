/**
 * browser-lock.ts — PURE: the padlock of a session's browser (NAVEGADOR S3, spec §1.6 / §4 / §7a).
 *
 * Who holds a session's browser: the MODEL (locked — the default) or the PERSON (unlocked). While the
 * person holds it, the model's ACTIONS are held (never executed) and its READS go on. Every rule is a
 * function of the state and the clock it is handed; `browser-lock-host.ts` keeps the state, the timers
 * and the waiting promises, and nothing here touches IO.
 *
 * The rules, each pinned by a test:
 * - an action asked while UNLOCKED is HELD until a deadline `holdMs = min(10 min, tool timeout − 5 s)`
 *   (the harness's own measured timeout, `@agentistics/core` `HARNESS_TOOL_TIMEOUT`; unmeasured ⇒ 50 s);
 * - the person locks before the deadline ⇒ the held action is NOT executed (the page changed and its refs
 *   may be stale) and comes back as a normal result saying when the person drove and what is on screen;
 * - the deadline passes still unlocked ⇒ the action is NOT executed and the answer says so in words,
 *   naming `agentistics_browser_wait_unlock`;
 * - a READ is never held; LOCKED proceeds;
 * - only the PERSON changes the padlock: a request carrying a session identity is refused
 *   (`session_cannot_unlock`, 403) — in both directions, so a session can neither free itself nor take
 *   the browser back from the person;
 * - the person's own browser (`personal`) has no padlock;
 * - unlocked and forgotten (15 min without the person's input and nobody watching) locks by itself and
 *   says so, or a hidden tab would hold the model forever;
 * - the browser stopping releases every held action with the reason.
 */

import { HARNESS_TOOL_TIMEOUT, TOOL_TIMEOUT_UNKNOWN_MS, type HarnessId } from '@agentistics/core'
import type { BrowserAction } from './browser-action-spec'

export type LockMode = 'locked' | 'unlocked'

export const HOLD_CAP_MS = 10 * 60_000
export const HOLD_MARGIN_MS = 5_000
export const HOLD_MIN_MS = 1_000
export const AUTO_LOCK_MS = 15 * 60_000
/** At most this many actions waiting per browser — more is a model retrying in a loop. */
export const MAX_HELD = 8
/** The MCP sends `notifications/progress` at least this often while a call is held (P4: ≤ 20 s). */
export const PROGRESS_EVERY_MS = 15_000

export interface HeldAction {
  id: string
  action: BrowserAction
  heldAt: number
  deadline: number
}

export interface LockState {
  mode: LockMode
  /** When the current mode began. */
  since: number
  /** The person's last input event (S4 reports it); null = none since unlocking. */
  lastPersonInputMs: number | null
  held: HeldAction[]
  /** Set when the padlock closed by itself; cleared by the next person change. */
  autoLockedAt: number | null
}

export interface PageFacts { title?: string; url?: string }

/** What a held/waiting call answers. `ok:false` only where the model must change course. */
export interface LockAnswer { ok: boolean; [k: string]: unknown }

export function initialLock(now: number): LockState {
  return { mode: 'locked', since: now, lastPersonInputMs: null, held: [], autoLockedAt: null }
}

/** How long an action may be held for this harness (and the longest `wait_unlock`). */
export function holdMsFor(harness: HarnessId | undefined | null): number {
  const t = harness ? HARNESS_TOOL_TIMEOUT[harness] : null
  return holdMsForTimeout(t ? t.ms : TOOL_TIMEOUT_UNKNOWN_MS)
}

/** The clamp itself, for a measured tool timeout: never past `HOLD_CAP_MS`, never under `HOLD_MIN_MS`. */
export function holdMsForTimeout(timeoutMs: number): number {
  return Math.max(HOLD_MIN_MS, Math.min(HOLD_CAP_MS, timeoutMs - HOLD_MARGIN_MS))
}

/** `HH:MM` on this machine's clock — what the person saw on their own screen. */
export function hhmm(ms: number): string {
  const d = new Date(ms)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

function pageLine(p: PageFacts | undefined): string {
  const title = (p?.title ?? '').trim().slice(0, 120)
  const url = (p?.url ?? '').trim().slice(0, 300)
  if (!title && !url) return 'unknown'
  if (!title) return url
  if (!url) return title
  return `${title} — ${url}`
}

function minutes(ms: number): number {
  return Math.max(0, Math.floor(ms / 60_000))
}

// ---------------------------------------------------------------------------------------------------
// The gate: an action asked of a session's browser.

export type GateDecision =
  | { kind: 'proceed' }
  | { kind: 'hold'; state: LockState; held: HeldAction }
  | { kind: 'refuse'; answer: LockAnswer }

export function decideGate(
  state: LockState,
  input: { action: BrowserAction; isRead: boolean; now: number; holdMs: number; id: string },
): GateDecision {
  if (input.isRead || state.mode === 'locked') return { kind: 'proceed' }
  if (state.held.length >= MAX_HELD) {
    return {
      kind: 'refuse',
      answer: {
        ok: false, performed: false, error: 'person_driving',
        sentence: `The person is using this session's browser and ${state.held.length} of your actions are already waiting. Nothing was done. Wait with agentistics_browser_wait_unlock instead of retrying.`,
      },
    }
  }
  const held: HeldAction = { id: input.id, action: input.action, heldAt: input.now, deadline: input.now + input.holdMs }
  return { kind: 'hold', state: { ...state, held: [...state.held, held] }, held }
}

/** The answer of a held action whose deadline passed with the padlock still open. */
export function deadlineAnswer(state: LockState, now: number): LockAnswer {
  const n = minutes(now - state.since)
  return {
    ok: false, performed: false, error: 'person_driving', unlockedForMinutes: n,
    sentence: `The person is using this session's browser (unlocked ${n} min ago). Your action was not done. Wait with agentistics_browser_wait_unlock or go on with another part of the work.`,
  }
}

/** The answer of a held action when the person handed the browser back (locked) before its deadline. */
export function returnedAnswer(from: number, to: number, page: PageFacts | undefined): LockAnswer {
  return {
    ok: true, performed: false, reason: 'person_returned',
    sentence: `The person used this session's browser from ${hhmm(from)} to ${hhmm(to)} and gave control back. Your action was NOT done: the page may have changed (now: ${pageLine(page)}). Take agentistics_browser_snapshot before acting again.`,
  }
}

/** The answer of every held action when the browser itself stopped. */
export function stoppedAnswer(reason: string): LockAnswer {
  return {
    ok: false, performed: false, error: 'browser_closed',
    sentence: `This session's browser was closed (${reason}) while your action waited. Nothing was done; the next browser call opens a fresh one.`,
  }
}

/** Drops the held actions whose deadline has passed; each gets `deadlineAnswer`. */
export function expireHeld(state: LockState, now: number): { state: LockState; expired: { id: string; answer: LockAnswer }[] } {
  const expired = state.held.filter(h => h.deadline <= now)
  if (expired.length === 0) return { state, expired: [] }
  const answer = deadlineAnswer(state, now)
  return {
    state: { ...state, held: state.held.filter(h => h.deadline > now) },
    expired: expired.map(h => ({ id: h.id, answer })),
  }
}

/** The earliest deadline still pending, or null. */
export function nextDeadline(state: LockState): number | null {
  return state.held.length === 0 ? null : Math.min(...state.held.map(h => h.deadline))
}

// ---------------------------------------------------------------------------------------------------
// S4b — the person's vault proof that an unlock carries.

/** What the padlock route needs to know about THIS request's owner grant (`X-Agentop-Owner-Grant`). */
export type OwnerProofVerdict =
  | { ok: true; grantId: string }
  | { ok: false; status: 403; error: 'owner_proof_required' | 'owner_proof_scope' | 'owner_proof_local_only' | 'owner_proof_unavailable'; sentence: string; action?: { kind: 'open-vault'; path: '/vault' } }

/**
 * PURE. A spent grant's refusal, in the person's language. `setup` = this machine's vault cannot give the
 * proof at all (not set up, or silent protection only): the sentence says what to do and the answer carries
 * the action that does it (open the Vault) — the person is never told to run a command.
 */
export function ownerProofRefusal(
  code: 'grant-invalid' | 'grant-scope' | 'owner-proof-local-only',
  lang: 'pt' | 'en',
  setup: boolean,
  subject: 'unlock' | 'profiles' = 'unlock',
): Extract<OwnerProofVerdict, { ok: false }> {
  const pt = lang === 'pt'
  if (subject === 'profiles') {
    const e = code === 'owner-proof-local-only' ? 'owner_proof_local_only' : setup ? 'owner_proof_unavailable' : code === 'grant-scope' ? 'owner_proof_scope' : 'owner_proof_required'
    const sentence = code === 'owner-proof-local-only'
      ? (pt ? 'Apagar os perfis só pode ser confirmado neste computador.' : 'Deleting the profiles can only be confirmed on this computer.')
      : setup
        ? (pt ? 'Para apagar os perfis do navegador, o agentistics precisa confirmar que é você. Abra o Cofre e crie uma senha (ou ative o Windows Hello / Touch ID); depois tente de novo.'
          : 'To delete the browser profiles, agentistics needs to confirm it is you. Open the Vault and set a password (or turn on Windows Hello / Touch ID), then try again.')
        : (pt ? 'Confirme que é você (senha do Cofre, Windows Hello ou Touch ID) para apagar os perfis. Cada confirmação vale uma vez, por 5 minutos; nenhum perfil foi apagado.'
          : 'Confirm it is you (Vault password, Windows Hello or Touch ID) to delete the profiles. Each confirmation works once, for 5 minutes; no profile was deleted.')
    return { ok: false, status: 403, error: e, ...(setup && code !== 'owner-proof-local-only' ? { action: { kind: 'open-vault' as const, path: '/vault' as const } } : {}), sentence }
  }
  if (code === 'owner-proof-local-only') {
    return { ok: false, status: 403, error: 'owner_proof_local_only', sentence: pt
      ? 'Assumir o navegador de uma sessão só pode ser confirmado neste computador.'
      : "Taking over a session's browser can only be confirmed on this computer." }
  }
  if (setup) {
    return { ok: false, status: 403, error: 'owner_proof_unavailable', action: { kind: 'open-vault', path: '/vault' }, sentence: pt
      ? 'Para assumir o navegador de uma sessão, o agentistics precisa confirmar que é você. Abra o Cofre e crie uma senha (ou ative o Windows Hello / Touch ID); depois tente de novo.'
      : "To take over a session's browser, agentistics needs to confirm it is you. Open the Vault and set a password (or turn on Windows Hello / Touch ID), then try again." }
  }
  if (code === 'grant-scope') {
    return { ok: false, status: 403, error: 'owner_proof_scope', sentence: pt
      ? 'Essa confirmação era para o navegador de outra sessão. Confirme de novo para este.'
      : "That confirmation was for another session's browser. Confirm again for this one." }
  }
  return { ok: false, status: 403, error: 'owner_proof_required', sentence: pt
    ? 'Confirme que é você (senha do Cofre, Windows Hello ou Touch ID) para assumir este navegador. Cada confirmação vale uma vez, por 5 minutos.'
    : 'Confirm it is you (Vault password, Windows Hello or Touch ID) to take over this browser. Each confirmation works once, for 5 minutes.' }
}

// ---------------------------------------------------------------------------------------------------
// Changing the padlock.

export type LockRequestDecision =
  | { ok: true; managedId: string; mode: LockMode }
  | { ok: false; status: 400 | 403; error: string; sentence: string }

/**
 * Who may change the padlock (spec §1.6 / §4): only the PERSON. A request that carries a session
 * identity — verified, forged or empty — is refused before anything else is read, so no session can
 * free itself (or another), and none can take the browser back from the person.
 */
export function decideLockRequest(input: { carriesSession: boolean; owner: unknown; lock: unknown }): LockRequestDecision {
  if (input.carriesSession) {
    return {
      ok: false, status: 403, error: 'session_cannot_unlock',
      sentence: "Only the person can lock or unlock a session's browser; a session cannot change the padlock.",
    }
  }
  if (input.lock !== 'locked' && input.lock !== 'unlocked') {
    return { ok: false, status: 400, error: 'bad_lock', sentence: 'lock must be "locked" or "unlocked".' }
  }
  const o = input.owner
  if (o === 'personal' || (o && typeof o === 'object' && (o as { kind?: unknown }).kind === 'personal')) {
    return { ok: false, status: 400, error: 'personal_has_no_lock', sentence: "The person's own browser has no padlock; only a session's browser does." }
  }
  const id = typeof o === 'string' ? o : o && typeof o === 'object' ? (o as { managedId?: unknown }).managedId : undefined
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(id)) {
    return { ok: false, status: 400, error: 'bad_owner', sentence: 'owner must name a session (its managed id).' }
  }
  return { ok: true, managedId: id, mode: input.lock }
}

/**
 * The person (or the auto-lock) sets the padlock. Locking releases every held action with
 * `returnedAnswer` — none of them runs. Setting the mode it already has changes nothing.
 */
export function setMode(
  state: LockState,
  input: { mode: LockMode; now: number; by: 'person' | 'auto'; page?: PageFacts },
): { state: LockState; changed: boolean; released: { id: string; answer: LockAnswer }[] } {
  if (state.mode === input.mode) return { state, changed: false, released: [] }
  if (input.mode === 'unlocked') {
    return {
      state: { mode: 'unlocked', since: input.now, lastPersonInputMs: null, held: [], autoLockedAt: null },
      changed: true, released: [],
    }
  }
  const answer = returnedAnswer(state.since, input.now, input.page)
  return {
    state: { mode: 'locked', since: input.now, lastPersonInputMs: null, held: [], autoLockedAt: input.by === 'auto' ? input.now : null },
    changed: true,
    released: state.held.map(h => ({ id: h.id, answer })),
  }
}

/** The person's input reached the browser (S4): it keeps an unlocked padlock from closing by itself. */
export function notePersonInput(state: LockState, now: number): LockState {
  return state.mode === 'unlocked' ? { ...state, lastPersonInputMs: now } : state
}

/** Unlocked, nobody watching and no input from the person for 15 min ⇒ it locks by itself. */
export function autoLockDue(state: LockState, input: { now: number; viewers: number }): boolean {
  if (state.mode !== 'unlocked' || input.viewers > 0) return false
  const last = Math.max(state.since, state.lastPersonInputMs ?? 0)
  return input.now - last >= AUTO_LOCK_MS
}

/** The browser stopped: every held action is released with the reason; the padlock returns to locked. */
export function onBrowserStopped(state: LockState, input: { now: number; reason: string }): { state: LockState; released: { id: string; answer: LockAnswer }[] } {
  const answer = stoppedAnswer(input.reason)
  return { state: initialLock(input.now), released: state.held.map(h => ({ id: h.id, answer })) }
}

// ---------------------------------------------------------------------------------------------------
// wait_unlock: the model waits for the person to hand the browser back.

export type WaitDecision =
  | { kind: 'now'; answer: LockAnswer }
  | { kind: 'wait'; deadline: number }

/** `maxMs` is the model's wish, clamped to `[HOLD_MIN_MS, holdMs]` — never past its own harness's timeout. */
export function decideWait(state: LockState, input: { now: number; maxMs: unknown; holdMs: number }): WaitDecision {
  if (state.mode === 'locked') {
    return {
      kind: 'now',
      answer: {
        ok: true, locked: true, waitedMs: 0,
        sentence: state.autoLockedAt !== null
          ? `The browser is yours: the padlock closed by itself at ${hhmm(state.autoLockedAt)} after the person left it. Take agentistics_browser_snapshot before acting.`
          : 'The browser is yours (the padlock is locked; the person is not using it).',
      },
    }
  }
  const asked = typeof input.maxMs === 'number' && Number.isFinite(input.maxMs) ? input.maxMs : input.holdMs
  const ms = Math.max(HOLD_MIN_MS, Math.min(input.holdMs, Math.floor(asked)))
  return { kind: 'wait', deadline: input.now + ms }
}

/** A waiter's answer once the person locked: the browser is back, and the page may have changed. */
export function waitReturnedAnswer(from: number, to: number, waitedMs: number, page: PageFacts | undefined): LockAnswer {
  return {
    ok: true, locked: true, waitedMs,
    sentence: `The person used this session's browser from ${hhmm(from)} to ${hhmm(to)} and gave control back. The page may have changed (now: ${pageLine(page)}). Take agentistics_browser_snapshot before acting.`,
  }
}

/** A waiter's answer when its own deadline came first. */
export function waitTimedOutAnswer(state: LockState, now: number, waitedMs: number): LockAnswer {
  const n = minutes(now - state.since)
  return {
    ok: true, locked: false, waitedMs, unlockedForMinutes: n,
    sentence: `The person is still using this session's browser (unlocked ${n} min ago). Call agentistics_browser_wait_unlock again or go on with another part of the work.`,
  }
}
