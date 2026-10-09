/**
 * adapter-state.ts — what each session's HARNESS says about its own state, read through the engine's
 * chat channel (engine-api 1.9 `HarnessChat`, `state` deltas), for the fleet poller (ENGINE.MAP F1.2,
 * P-27 host half; 09 §2 "turn started / ended" and "session list").
 *
 * Without it a turn's end is inferred from the SCREEN: the frame stops moving, a 6 s quiet window, and
 * two consecutive polls to confirm — 6 to 16 s after the harness wrote its last line. A harness whose
 * transcript states its turns (`declares.state.from`) says it the instant it writes, so with the
 * `adapter-chat` flag on, that statement is the row's activity, the poll is asked for at once
 * (`onChange`), and the screen is captured only where it still has something to say:
 *
 * - never for an IDLE row (its harness said the turn ended — a permission dialog lives inside a turn);
 * - for a WORKING row only when the harness's file cannot say it is waiting on a person
 *   (`declares.attention` absent), because then only the screen can show the dialog;
 * - always when the file says a person is being waited on (the options are read off the screen);
 * - once every `SCREEN_REFRESH_MS` regardless, for what only the frame carries (the mode chip, a
 *   rate-limit banner, the raw tail), and on the next poll after an act on the row (`forceScreen`).
 *
 * A row whose harness declares NO state (gemini; opencode has no chat at all), a row with no exact
 * conversation link, and every row with the flag off, are untouched: the screen decides, as before.
 *
 * Pure decisions (`planScreen`, `adapterActivity`) are exported and tested; the feed holds one engine
 * subscription per conversation and drops it when the row stops running.
 */
import type { ChatSourceRef, HarnessChat } from '@agentistics/engine-api'
import type { SessionActivity } from './types'

/** How often an adapter-stated row's screen is read anyway, for what only the frame carries. */
export const SCREEN_REFRESH_MS = 120_000
/** Collapses a burst of state changes (several sessions ending a turn together) into one poll. */
export const CHANGE_DEBOUNCE_MS = 50
/** How few turns the state subscription asks for: it reads state, not the conversation. */
const STATE_WINDOW = 1

/** What the harness said, as the poller reads it. */
export interface AdapterReading {
  working: boolean
  /** The harness's FILE says a person is being waited on. */
  attention: boolean
  /** The harness can say the above at all (`declares.attention.from`). */
  coversAttention: boolean
}

/** PURE. Must this poll read the row's screen? */
export function planScreen(o: {
  reading: AdapterReading | undefined
  lastScreenMs: number | undefined
  nowMs: number
  forced: boolean
}): boolean {
  if (!o.reading) return true
  if (o.forced) return true
  if (o.lastScreenMs === undefined || o.nowMs - o.lastScreenMs >= SCREEN_REFRESH_MS) return true
  if (o.reading.attention) return true
  return o.reading.working && !o.reading.coversAttention
}

/**
 * PURE. The row's activity when the harness stated it. `screen` is what the frame read, when it was
 * read: a dialog the SCREEN shows wins (only the screen can show one the file does not record).
 */
export function adapterActivity(reading: AdapterReading, screen: SessionActivity | undefined): SessionActivity {
  if (reading.attention || screen === 'waiting-approval') return 'waiting-approval'
  return reading.working ? 'working' : 'waiting'
}

/** One live row, as the poller knows it. */
export interface AdapterStateRow {
  id: string
  harness?: string
  conversationId?: string
  cwd?: string
}

export interface AdapterStateFeed {
  /** The rows running NOW: follow the new ones, release the ones that are gone. */
  sync(rows: readonly AdapterStateRow[]): void
  /** The latest reading for a row, or `undefined` (not followed, or nothing said yet). */
  reading(id: string): AdapterReading | undefined
  /** Read this row's screen on the next poll (an act was just performed on it). */
  forceScreen(id: string): void
  /** Consumes the force. */
  takeForced(id: string): boolean
  /** When the row's screen was last read (the poller says so). */
  screenRead(id: string, atMs: number): void
  lastScreen(id: string): number | undefined
  /** Called (debounced) when any reading changes. */
  onChange(cb: () => void): () => void
  /** Rows followed now — tests and health. */
  followed(): string[]
  stop(): void
}

export function createAdapterStateFeed(o: {
  /** The engine's chat channel for a harness, or `undefined` (no engine / a declared absence). */
  chatOf(harness: string): HarnessChat | undefined
  setTimer?: (f: () => void, ms: number) => unknown
  clearTimer?: (t: unknown) => void
}): AdapterStateFeed {
  const setTimer = o.setTimer ?? ((f, ms) => setTimeout(f, ms))
  const clearTimer = o.clearTimer ?? (t => clearTimeout(t as ReturnType<typeof setTimeout>))
  interface Entry {
    key: string
    unfollow: (() => void) | null
    reading: AdapterReading | undefined
    alive: boolean
  }
  const entries = new Map<string, Entry>()
  const forced = new Set<string>()
  const screens = new Map<string, number>()
  const listeners = new Set<() => void>()
  let debounce: unknown = null

  const changed = () => {
    if (debounce !== null) return
    debounce = setTimer(() => { debounce = null; for (const l of listeners) { try { l() } catch { /* a listener never breaks the feed */ } } }, CHANGE_DEBOUNCE_MS)
  }

  function release(id: string) {
    const e = entries.get(id)
    if (!e) return
    e.alive = false
    try { e.unfollow?.() } catch { /* total by contract */ }
    entries.delete(id)
    screens.delete(id)
    forced.delete(id)
  }

  function follow(row: AdapterStateRow & { harness: string; conversationId: string }, chat: HarnessChat) {
    const key = `${row.harness}\0${row.conversationId}`
    const e: Entry = { key, unfollow: null, reading: undefined, alive: true }
    entries.set(row.id, e)
    const coversAttention = chat.declares.attention.from !== undefined
    void (async () => {
      let src: ChatSourceRef | null = null
      try {
        src = await chat.resolve({ conversationId: row.conversationId, ...(row.cwd ? { cwd: row.cwd } : {}) })
      } catch { src = null }
      if (!e.alive) return
      if (!src) {
        // Nothing written yet: the screen decides, and the next sync tries again.
        entries.delete(row.id)
        return
      }
      e.unfollow = chat.follow(src, STATE_WINDOW, d => {
        if (!e.alive || d.kind !== 'state') return
        const next: AdapterReading = { working: d.working, attention: d.attention !== undefined, coversAttention }
        const prev = e.reading
        e.reading = next
        if (!prev || prev.working !== next.working || prev.attention !== next.attention) changed()
      })
    })()
  }

  return {
    sync(rows) {
      const live = new Set<string>()
      for (const row of rows) {
        if (!row.harness || !row.conversationId) continue
        const chat = o.chatOf(row.harness)
        if (!chat || chat.declares.state.from === undefined) continue
        live.add(row.id)
        const key = `${row.harness}\0${row.conversationId}`
        const cur = entries.get(row.id)
        if (cur && cur.key === key) continue
        if (cur) release(row.id) // the row moved to another conversation (a reopen, a /clear)
        follow({ ...row, harness: row.harness, conversationId: row.conversationId }, chat)
      }
      for (const id of [...entries.keys()]) if (!live.has(id)) release(id)
    },
    reading: id => entries.get(id)?.reading,
    forceScreen(id) { forced.add(id) },
    takeForced(id) { return forced.delete(id) },
    screenRead(id, atMs) { screens.set(id, atMs) },
    lastScreen: id => screens.get(id),
    onChange(cb) { listeners.add(cb); return () => { listeners.delete(cb) } },
    followed: () => [...entries.keys()],
    stop() {
      for (const id of [...entries.keys()]) release(id)
      listeners.clear()
      if (debounce !== null) { clearTimer(debounce); debounce = null }
    },
  }
}
