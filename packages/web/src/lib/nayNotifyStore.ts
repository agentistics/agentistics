/**
 * nayNotifyStore.ts — the cards the Nay button is holding, and the memory behind them.
 *
 * An external store (the `useSyncExternalStore` shape `notifications.ts` uses) because the thing
 * that DECIDES a session needs somebody is the fleet poll in `fleet.ts`, which runs at module scope,
 * while the thing that SHOWS it is the card mounted beside the button. Neither is inside the other.
 *
 * It owns four memories, each with a stated lifetime:
 *  - the QUEUE of cards to show (in memory — a card is about now, and a reload is a new now);
 *  - when each session started WAITING (in memory; a fresh page does not know, and says so);
 *  - when each session was last OPENED (per browser, `localStorage` — opening a session is
 *    something this viewer did, and it is what "not opened for a while" is measured from);
 *  - the SNOOZES (per browser, `localStorage`, so a snooze survives a reload: a snooze that a
 *    refresh forgets comes back early and teaches people the button does not work).
 *
 * Nothing here decides a rule — `nayNotify.ts` does — and nothing here approves anything.
 */

import { useSyncExternalStore } from 'react'
import { alertKey, alertStillTrue, staleDue, type NayAlert, type NayAlertKind } from './nayNotify'
import { dismissNotification, readNotifications, type AppNotification } from './notifications'

interface State {
  queue: NayAlert[]
  /** Bumped once per "the session replied" — the button's shock listens to the change. */
  shock: number
}

let state: State = { queue: [], shock: 0 }
const listeners = new Set<() => void>()
function emit(): void { for (const l of listeners) l() }

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key)
    return raw === null ? fallback : JSON.parse(raw) as T
  } catch { return fallback }
}
function writeJson(key: string, value: unknown): void {
  try { localStorage.setItem(key, JSON.stringify(value)) } catch { /* private window: a convenience lost, nothing else */ }
}

const OPENED_KEY = 'agentistics-nay-opened'
const SNOOZE_KEY = 'agentistics-nay-snoozes'
/** Opened-at stamps older than this are forgotten, so the map cannot grow for ever. */
const OPENED_TTL_MS = 7 * 24 * 3_600_000

interface Snooze { alert: NayAlert; until: number }

function isSnooze(v: unknown): v is Snooze {
  const s = v as Snooze
  return !!s && typeof s.until === 'number' && !!s.alert && typeof s.alert.key === 'string' && typeof s.alert.sessionId === 'string'
}

let snoozes: Snooze[] = typeof window === 'undefined' ? [] : readJson<unknown[]>(SNOOZE_KEY, []).filter(isSnooze)

// --- the session that is open on screen ---------------------------------------------------------

let openSession: string | null = null

/**
 * The session the person is looking at right now, or null. A card about it is never shown — they
 * are already there — and opening one counts as having looked at it.
 */
export function setOpenSession(id: string | null): void {
  openSession = id
  if (!id) return
  markOpened(id)
  const next = state.queue.filter(a => a.sessionId !== id)
  if (next.length !== state.queue.length) { state = { ...state, queue: next }; emit() }
}

/**
 * Sessions the person can SEE right now besides the open page: a detached Nay window that is not
 * minimized, and the session the open dock is showing. A card about one is never raised — the owner
 * is looking at it (2026-09-30) — and it is raised again as usual once that window is minimized or
 * closed. Being on screen counts as having looked at it, for "not opened for a while".
 */
let visibleSessions = new Set<string>()

export function setVisibleSessions(ids: readonly string[]): void {
  visibleSessions = new Set(ids)
  for (const id of visibleSessions) markOpened(id)
  const next = state.queue.filter(a => !visibleSessions.has(a.sessionId))
  if (next.length !== state.queue.length) { state = { ...state, queue: next }; emit() }
}

/** Is this session on screen (its page open, or a visible window showing it)? */
function onScreen(id: string): boolean {
  return id === openSession || visibleSessions.has(id)
}

function markOpened(id: string, now = Date.now()): void {
  const map = readJson<Record<string, number>>(OPENED_KEY, {})
  map[id] = now
  for (const [k, v] of Object.entries(map)) if (typeof v !== 'number' || now - v > OPENED_TTL_MS) delete map[k]
  writeJson(OPENED_KEY, map)
}

function lastOpened(id: string): number | undefined {
  const v = readJson<Record<string, number>>(OPENED_KEY, {})[id]
  return typeof v === 'number' ? v : undefined
}

// --- the queue ----------------------------------------------------------------------------------

function snoozedSession(sessionId: string, now: number): boolean {
  return snoozes.some(s => s.alert.sessionId === sessionId && s.until > now)
}

/**
 * The settings DEMO card: names no session, so it offers only snooze and dismiss. ONE builder for
 * every "Testar" button (Settings → Notificações and Settings → Chat), so the two previews are the
 * same card.
 */
export function pushDemoAlert(lang: 'pt' | 'en', now = Date.now()): void {
  pushAlert({
    key: alertKey('turn', 'demo', now), kind: 'turn', sessionId: 'demo', demo: true,
    name: lang === 'pt' ? 'Sessão de exemplo' : 'Example session', harness: 'claude', model: 'claude-opus-5-5',
    sinceMs: now - 3 * 60_000, sinceKnown: true,
  }, now)
}

// --- the bell: what still waits on the person ----------------------------------------------------

/**
 * WHERE A HIDDEN CARD GOES (owner, 2026-09-30): to the header BELL, not to a list inside the chat.
 * Every card's event is already written to the bell when it is delivered; what the bell must ALSO
 * do is drop it once the session no longer needs the person — answered, back at work, or gone — so
 * the history shows what is still waiting rather than everything that ever waited. That used to be
 * the in-chat inbox's job; the inbox and its badge on the button are gone.
 */
const BELL_KIND: Readonly<Record<string, NayAlertKind>> = {
  'session.turn_ended': 'turn', 'session.needs_approval': 'approval', 'session.stale': 'stale',
}

/** PURE: the bell entries about a session that no longer needs the person. */
export function bellEntriesToDrop(
  items: readonly Pick<AppNotification, 'id' | 'code' | 'meta'>[],
  stillTrue: (kind: NayAlertKind, sessionId: string) => boolean,
): string[] {
  const out: string[] = []
  for (const n of items) {
    const kind = n.code ? BELL_KIND[n.code] : undefined
    const id = typeof n.meta?.sessionId === 'string' ? n.meta.sessionId : undefined
    if (kind && id && !stillTrue(kind, id)) out.push(n.id)
  }
  return out
}

function pruneBell(): void {
  for (const id of bellEntriesToDrop(readNotifications(), (k, sid) => alertStillTrue(k, latest.get(sid)))) dismissNotification(id)
}

/** Queue a card. Refused (false) when it is already up, when its session is open, or while snoozed. */
export function pushAlert(a: NayAlert, now = Date.now()): boolean {
  if (onScreen(a.sessionId)) return false
  if (state.queue.some(x => x.key === a.key)) return false
  if (snoozedSession(a.sessionId, now)) return false
  // One card per session: a newer occurrence replaces the older one rather than stacking beside it.
  state = { ...state, queue: [...state.queue.filter(x => x.sessionId !== a.sessionId), a] }
  emit()
  return true
}

export function dismissAlert(key: string): void {
  const next = state.queue.filter(a => a.key !== key)
  if (next.length === state.queue.length) return
  state = { ...state, queue: next }
  emit()
}

export function snoozeAlert(key: string, ms: number, now = Date.now()): void {
  const a = state.queue.find(x => x.key === key)
  if (!a) return
  snoozes = [...snoozes.filter(s => s.alert.sessionId !== a.sessionId), { alert: a, until: now + ms }]
  writeJson(SNOOZE_KEY, snoozes)
  dismissAlert(key)
  ensureTimer()
}

/** "The session replied" — the button shocks. The card, if any, is a separate decision. */
export function requestShock(): void {
  state = { ...state, shock: state.shock + 1 }
  emit()
}

// --- what the fleet says ------------------------------------------------------------------------

interface Since { state: string; sinceMs: number; known: boolean }
const since = new Map<string, Since>()
const latest = new Map<string, string>()
const staleRaised = new Set<string>()

const WAITING = (s: string) => s === 'waiting' || s === 'waiting-approval'

export interface StaleCandidate { id: string; sinceMs: number; known: boolean }

/**
 * Read one poll of the fleet. Keeps when each session started waiting, drops the cards that are no
 * longer true, and returns the sessions that have just crossed the "not opened for a while" line —
 * each ONCE per waiting episode.
 *
 * A waiting episode is contiguous `waiting` / `waiting-approval`: a session that asks for approval
 * in the middle of waiting on a person has not stopped waiting. A session seen for the first time
 * already waiting starts its clock NOW and is marked `known: false`.
 */
export function observeFleet(rows: readonly { id: string; state: string }[], thresholdMin: number, now = Date.now()): StaleCandidate[] {
  const seen = new Set<string>()
  for (const r of rows) {
    seen.add(r.id)
    latest.set(r.id, r.state)
    const prev = since.get(r.id)
    if (prev && (prev.state === r.state || (WAITING(prev.state) && WAITING(r.state)))) {
      since.set(r.id, { ...prev, state: r.state })
    } else {
      since.set(r.id, { state: r.state, sinceMs: now, known: prev !== undefined })
    }
  }
  for (const id of [...since.keys()]) if (!seen.has(id)) { since.delete(id); latest.delete(id) }

  // A settings DEMO names no session, so the fleet can never confirm it — it stays until dismissed.
  pruneBell()
  const queue = state.queue.filter(a => a.demo || alertStillTrue(a.kind, latest.get(a.sessionId)))
  if (queue.length !== state.queue.length) { state = { ...state, queue }; emit() }

  const out: StaleCandidate[] = []
  for (const [id, s] of since) {
    const mark = `${id}:${s.sinceMs}`
    if (staleRaised.has(mark) || onScreen(id) || snoozedSession(id, now)) continue
    if (!staleDue({ state: s.state, sinceMs: s.sinceMs, lastOpenedMs: lastOpened(id), nowMs: now, thresholdMin })) continue
    staleRaised.add(mark)
    out.push({ id, sinceMs: s.sinceMs, known: s.known })
  }
  ensureTimer()
  return out
}

/** When this session's current state began, as the page knows it. */
export function waitingSince(id: string): { sinceMs: number; known: boolean } | undefined {
  const s = since.get(id)
  return s ? { sinceMs: s.sinceMs, known: s.known } : undefined
}

// --- snoozes coming back ------------------------------------------------------------------------

let releaseHandler: ((a: NayAlert) => void) | null = null

/** Who raises a snoozed card again (sound, settings). Registered by `sessionNotifications.ts`. */
export function setSnoozeReleaseHandler(fn: (a: NayAlert) => void): void { releaseHandler = fn }

let timer: ReturnType<typeof setInterval> | null = null

function ensureTimer(): void {
  if (timer !== null || snoozes.length === 0 || typeof window === 'undefined') return
  timer = setInterval(releaseDue, 10_000)
}

/**
 * Bring back what is due. A snoozed card comes back only if what it said is STILL true — a session
 * answered in the meantime has nothing left to remind anybody about — and a session the page cannot
 * see at all (the poll has not run yet) waits for a poll rather than being dropped.
 */
export function releaseDue(now = Date.now()): void {
  const due = snoozes.filter(s => s.until <= now)
  if (due.length > 0) {
    const keep: Snooze[] = []
    for (const s of snoozes) {
      if (s.until > now) { keep.push(s); continue }
      if (!latest.has(s.alert.sessionId) && since.size === 0) { keep.push(s); continue }
      if (!alertStillTrue(s.alert.kind, latest.get(s.alert.sessionId))) continue
      queueMicrotask(() => { releaseHandler ? releaseHandler(s.alert) : pushAlert(s.alert) })
    }
    snoozes = keep
    writeJson(SNOOZE_KEY, snoozes)
  }
  if (snoozes.length === 0 && timer !== null) { clearInterval(timer); timer = null }
}

// --- reading ------------------------------------------------------------------------------------

function subscribe(cb: () => void): () => void {
  listeners.add(cb)
  return () => { listeners.delete(cb) }
}

export function useNayAlerts(): NayAlert[] {
  return useSyncExternalStore(subscribe, () => state.queue, () => state.queue)
}

export function useNayShock(): number {
  return useSyncExternalStore(subscribe, () => state.shock, () => state.shock)
}

export function readNayAlerts(): NayAlert[] { return state.queue }

/** Test seam: every memory back to a fresh page. */
export function resetNayNotifyStore(): void {
  state = { queue: [], shock: 0 }
  since.clear(); latest.clear(); staleRaised.clear()
  snoozes = []
  openSession = null
  visibleSessions = new Set()
  if (timer !== null) { clearInterval(timer); timer = null }
}
