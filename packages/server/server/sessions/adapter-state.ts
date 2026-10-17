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
 * F4.A: the same subscription also keeps the row's last `TAIL_WINDOW` turns (`tail`), so a row whose
 * harness serves a chat is followed even when it declares NO state (gemini) — its reading then stays
 * `undefined` and the screen decides its activity, as before. opencode has no chat at all; a row with
 * no exact conversation link, and every row with the flag off, are untouched.
 *
 * Pure decisions (`planScreen`, `adapterActivity`) are exported and tested; the feed holds one engine
 * subscription per conversation and drops it when the row stops running.
 */
import { ADAPTER_REFUSAL_MS, logForeign, sourceForeign } from './adapter-chat'
import { applyHarnessChatDeltas, type ChatSourceRef, type EngineChatTurn, type HarnessChat } from '@agentistics/engine-api'
import type { SessionActivity } from './types'

/** How often an adapter-stated row's screen is read anyway, for what only the frame carries. */
export const SCREEN_REFRESH_MS = 120_000
/** Collapses a burst of state changes (several sessions ending a turn together) into one poll. */
export const CHANGE_DEBOUNCE_MS = 50
/**
 * How many turns the subscription keeps: the fleet row's six-turn tail (F4.A — this replaced the
 * poll's own `readRecent` file read, so the row's tail and its state come from ONE engine cursor).
 */
export const TAIL_WINDOW = 6

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
  /** The row's last `TAIL_WINDOW` turns, or `undefined` (not followed, or no window yet). */
  tail(id: string): EngineChatTurn[] | undefined
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
  /** Conversations OTHER rows own for this row (CROSSBIND); a source in it is not followed. */
  foreign?(row: AdapterStateRow): Promise<ReadonlySet<string>>
  setTimer?: (f: () => void, ms: number) => unknown
  clearTimer?: (t: unknown) => void
  now?: () => number
}): AdapterStateFeed {
  const now = o.now ?? Date.now
  const setTimer = o.setTimer ?? ((f, ms) => setTimeout(f, ms))
  const clearTimer = o.clearTimer ?? (t => clearTimeout(t as ReturnType<typeof setTimeout>))
  interface Entry {
    key: string
    unfollow: (() => void) | null
    reading: AdapterReading | undefined
    turns: { turns: EngineChatTurn[]; older: boolean } | undefined
    alive: boolean
    /**
     * CROSSBIND — the source being followed and its GENERATION. A `fork` moves to a new source (a new
     * generation) whose ownership is checked before anything it says is kept: until the check for the
     * CURRENT generation passes, its turns and state are held aside (`held*`), and a check that settles
     * for an older generation commits nothing.
     */
    src: ChatSourceRef | null
    gen: number
    approved: number
    heldTurns?: { turns: EngineChatTurn[]; older: boolean } | undefined
    heldReading?: AdapterReading | undefined
    /** The source turned out to be another row's: followed no more until this moment (then retried). */
    refusedUntil?: number
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

  function setReading(e: Entry, next: AdapterReading) {
    const prev = e.reading
    e.reading = next
    if (!prev || prev.working !== next.working || prev.attention !== next.attention) changed()
  }

  /** The followed source belongs to another row: drop everything it said and stop following it. */
  function refuse(e: Entry, own: string, src: ChatSourceRef) {
    if (!e.alive || e.refusedUntil !== undefined) return
    logForeign(own, src)
    try { e.unfollow?.() } catch { /* total by contract */ }
    e.unfollow = null
    e.src = null
    e.turns = undefined
    e.heldTurns = undefined
    e.heldReading = undefined
    e.refusedUntil = now() + ADAPTER_REFUSAL_MS
    if (e.reading) { e.reading = undefined; changed() }
  }

  /** Check `src` (generation `g`) against the CURRENT owners; commit what it held only if still current. */
  function check(e: Entry, row: AdapterStateRow & { conversationId: string }, src: ChatSourceRef, g: number) {
    if (!o.foreign) { if (e.gen === g) commit(e, g); return }
    void o.foreign(row).then(f => {
      if (!e.alive) return
      if (sourceForeign(src, row.conversationId, f)) { refuse(e, row.conversationId, src); return }
      if (e.gen === g) commit(e, g)
    }, () => { if (e.gen === g) refuse(e, row.conversationId, src) })
  }

  function commit(e: Entry, g: number) {
    if (e.approved === g || e.refusedUntil !== undefined) return
    e.approved = g
    if (e.heldTurns) e.turns = e.heldTurns
    const r = e.heldReading
    e.heldTurns = undefined
    e.heldReading = undefined
    if (r) setReading(e, r)
  }

  function follow(row: AdapterStateRow & { harness: string; conversationId: string }, chat: HarnessChat) {
    const key = `${row.harness}\0${row.conversationId}`
    const e: Entry = { key, unfollow: null, reading: undefined, turns: undefined, alive: true, src: null, gen: 0, approved: 0 }
    entries.set(row.id, e)
    const coversAttention = chat.declares.attention.from !== undefined
    void (async () => {
      let src: ChatSourceRef | null = null
      try {
        src = await chat.resolve({ conversationId: row.conversationId, ...(row.cwd ? { cwd: row.cwd } : {}) })
      } catch { src = null }
      if (!e.alive) return
      if (src && o.foreign) {
        const owners = await o.foreign(row).catch(() => null)
        if (!owners || sourceForeign(src, row.conversationId, owners)) src = null
      }
      if (!e.alive) return
      if (!src) {
        // Nothing written yet: the screen decides, and the next sync tries again.
        entries.delete(row.id)
        return
      }
      // Checked once already (above), against the owners of that moment: generation 1 is adopted.
      e.src = src
      e.gen = 1
      e.approved = 1
      e.unfollow = chat.follow(src, TAIL_WINDOW, d => {
        if (!e.alive || e.refusedUntil !== undefined) return
        if (d.kind === 'fork') {
          // A fork is followed by the NEW source's window and state: none of it is kept until that
          // source is shown not to be another row's (HIGH-1).
          const g = ++e.gen
          e.src = d.to
          e.heldTurns = undefined
          e.heldReading = undefined
          check(e, row, d.to, g)
          return
        }
        const current = e.approved === e.gen
        if (d.kind === 'window' || d.kind === 'append' || d.kind === 'grow') {
          const base = (current ? e.turns : e.heldTurns) ?? { turns: [], older: false }
          const next = applyHarnessChatDeltas(base, [d], TAIL_WINDOW)
          if (current) e.turns = next; else e.heldTurns = next
          return
        }
        if (d.kind !== 'state') return
        const next: AdapterReading = { working: d.working, attention: d.attention !== undefined, coversAttention }
        if (current) setReading(e, next); else e.heldReading = next
      })
    })()
  }

  return {
    sync(rows) {
      const live = new Set<string>()
      for (const row of rows) {
        if (!row.harness || !row.conversationId) continue
        const chat = o.chatOf(row.harness)
        // Followed for the tail even when the harness cannot state its turns (gemini): the reading
        // then stays `undefined` and the screen decides the activity, exactly as before.
        if (!chat) continue
        live.add(row.id)
        const key = `${row.harness}\0${row.conversationId}`
        const cur = entries.get(row.id)
        if (cur && cur.key === key) {
          if (cur.refusedUntil === undefined) {
            // Ownership can change under a followed source (a row registered since it was adopted):
            // re-asked on every sync, so a newly registered owner ends the follow (HIGH-4).
            if (cur.src && cur.approved === cur.gen) check(cur, { ...row, conversationId: row.conversationId }, cur.src, cur.gen)
            continue
          }
          if (now() < cur.refusedUntil) continue
        }
        if (cur) release(row.id) // the row moved to another conversation (a reopen, a /clear)
        follow({ ...row, harness: row.harness, conversationId: row.conversationId }, chat)
      }
      for (const id of [...entries.keys()]) if (!live.has(id)) release(id)
    },
    reading: id => entries.get(id)?.reading,
    tail: id => entries.get(id)?.turns?.turns,
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
