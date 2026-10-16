/**
 * AWAY MODE — the browser's one copy of `GET /api/away` (server/away.ts), shared by the settings
 * switch, the activation dialog and the header pill. It follows the shared SSE stream
 * (`event: away`) and re-renders once at `until`, since expiry is lazy (nothing is pushed then).
 * The rules and words sessions are told live in core's `awayMode.ts`.
 */
import { useSyncExternalStore } from 'react'
import { AWAY_OFF, AWAY_TOP_MODEL, awayActive, parseAwayState, type AwayAuthId, type AwayState, type AwayTopCaps, type HarnessId } from '@agentistics/core'
import { subscribeEvent } from './eventStream'

export interface AwaySnapshot {
  /** `null` until the first answer, or when this server has no away route (older build / central). */
  state: AwayState | null
  active: boolean
  activeSessions?: number
  cooldownMs?: number
}

let snap: AwaySnapshot = { state: null, active: false }
const listeners = new Set<() => void>()
let stop: (() => void) | null = null
let expiryTimer: ReturnType<typeof setTimeout> | null = null

function emit(state: AwayState | null, impact?: { activeSessions?: number; cooldownMs?: number }): void {
  const active = state ? awayActive(state, Date.now()) : false
  snap = { ...snap, ...impact, state, active }
  if (expiryTimer) { clearTimeout(expiryTimer); expiryTimer = null }
  if (active && state?.until) {
    const ms = Date.parse(state.until) - Date.now()
    // setTimeout caps near 24.8 days; a longer away period re-arms on the next refresh.
    if (ms > 0 && ms < 2 ** 31 - 1) expiryTimer = setTimeout(() => emit(state), ms + 500)
  }
  for (const l of listeners) l()
}

export async function refreshAway(): Promise<void> {
  try {
    const r = await fetch('/api/away', { cache: 'no-store' })
    if (!r.ok) return
    const body = await r.json() as { state?: unknown; activeSessions?: number; cooldownMs?: number }
    emit(parseAwayState(body.state), body)
  } catch { /* keep what is on screen */ }
}

function start(): () => void {
  void refreshAway()
  const offChange = subscribeEvent('away', () => { void refreshAway() })
  const offConnected = subscribeEvent('connected', () => { void refreshAway() })
  return () => { offChange(); offConnected() }
}

function subscribe(l: () => void): () => void {
  listeners.add(l)
  if (listeners.size === 1) stop = start()
  return () => {
    listeners.delete(l)
    if (listeners.size === 0) { stop?.(); stop = null }
  }
}

export function useAway(): AwaySnapshot {
  return useSyncExternalStore(subscribe, () => snap, () => snap)
}

export interface AwayRequest {
  on: boolean
  until?: string | null
  authorised?: AwayAuthId[]
  note?: string
  maxWorkers?: number
  /** Per provider: workers on its top model tier at once. */
  topCaps?: AwayTopCaps
}

/** PUT, then adopt the server's answer. Resolves to the server's error code on refusal. */
export async function setAway(req: AwayRequest): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const r = await fetch('/api/away', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(req) })
    const body = await r.json().catch(() => ({})) as { ok?: boolean; state?: unknown; error?: string }
    if (!r.ok || body.ok !== true) return { ok: false, error: body.error ?? `http_${r.status}` }
    emit(parseAwayState(body.state))
    return { ok: true }
  } catch {
    return { ok: false, error: 'unreachable' }
  }
}

/**
 * Switch ONE session's own away mode (`PUT /api/away/session`). The server records it and, when
 * the session is running and its effective state changed, tells it. Resolves to the server's
 * error code on refusal; the fleet row follows on the next fleet push.
 */
export async function setSessionAway(id: string, on: boolean, lang: 'pt' | 'en', scope?: 'active'): Promise<{ ok: true; queued: boolean; effective: boolean } | { ok: false; error: string }> {
  try {
    const r = await fetch('/api/away/session', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ target: id, on, lang, scope }) })
    const body = await r.json().catch(() => ({})) as { ok?: boolean; queued?: boolean; effective?: boolean; error?: string }
    if (!r.ok || body.ok !== true) return { ok: false, error: body.error ?? `http_${r.status}` }
    return { ok: true, queued: body.queued === true, effective: body.effective === true }
  } catch {
    return { ok: false, error: 'unreachable' }
  }
}

// ─── Pure helpers (tested) ────────────────────────────────────────────────────────────────────

export type UntilChoice = 'back' | '2h' | '4h' | '8h' | 'tomorrow9'
export const UNTIL_CHOICES: readonly UntilChoice[] = ['back', '2h', '4h', '8h', 'tomorrow9']

/** The ISO instant a choice means, on the LOCAL clock ("tomorrow 09:00" is the person's morning). */
export function untilFromChoice(c: UntilChoice, now: number): string | null {
  if (c === 'back') return null
  if (c === 'tomorrow9') {
    const d = new Date(now)
    d.setDate(d.getDate() + 1)
    d.setHours(9, 0, 0, 0)
    return d.toISOString()
  }
  const h = c === '2h' ? 2 : c === '4h' ? 4 : 8
  return new Date(now + h * 3_600_000).toISOString()
}

export function untilChoiceLabel(c: UntilChoice, lang: 'pt' | 'en'): string {
  const pt = lang === 'pt'
  switch (c) {
    case 'back': return pt ? 'Até eu voltar' : "Until I'm back"
    case '2h': return pt ? 'Por 2 horas' : 'For 2 hours'
    case '4h': return pt ? 'Por 4 horas' : 'For 4 hours'
    case '8h': return pt ? 'Por 8 horas' : 'For 8 hours'
    case 'tomorrow9': return pt ? 'Até amanhã às 09:00' : 'Until tomorrow 09:00'
  }
}

/** "until 09:00" / "until Mon 09:00" / "until I'm back" — local clock, short. */
export function awayUntilLabel(s: AwayState | null, lang: 'pt' | 'en', now: number): string {
  const pt = lang === 'pt'
  if (!s || s.until === null) return pt ? 'até você voltar' : "until you're back"
  const d = new Date(s.until)
  const time = d.toLocaleTimeString(pt ? 'pt-BR' : 'en-US', { hour: '2-digit', minute: '2-digit' })
  const sameDay = new Date(now).toDateString() === d.toDateString()
  const day = sameDay ? '' : `${d.toLocaleDateString(pt ? 'pt-BR' : 'en-US', { weekday: 'short' })} `
  return `${pt ? 'até' : 'until'} ${day}${time}`
}

/** Tests / fixtures. */
export function __setAwayForTest(state: AwayState | null, impact?: { activeSessions?: number; cooldownMs?: number }): void { emit(state, impact ?? { activeSessions: undefined, cooldownMs: undefined }) }
export const AWAY_INITIAL: AwayState = AWAY_OFF

/**
 * The providers the away dialog lists a top-model ceiling for: every harness with an ACTIVE plan
 * (a reported limit window or a plan registered in Settings → Billing — what
 * `agentistics_plan_limits` reads), plus any harness that already carries a stored ceiling so it
 * is never silently dropped. Display order is the shared harness order.
 */
export function activeCapProviders(
  order: readonly string[],
  limits: readonly { harness: string }[] | null,
  registered: readonly { harness: string }[],
  stored: AwayTopCaps,
): HarnessId[] {
  const on = new Set<string>([...(limits ?? []).map(l => l.harness), ...registered.map(r => r.harness), ...Object.keys(stored)])
  // Only harnesses a ceiling can name (the native engine has no plan of its own here).
  return order.filter((h): h is HarnessId => on.has(h) && h in AWAY_TOP_MODEL)
}
