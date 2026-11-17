/**
 * browser-screencast.ts — one screencast loop per WATCHED (browser, tab), shared by every reader of it
 * (NAVEGADOR S4, spec §1.5). The browser twin of `sessions/terminal-hub.ts`, and injectable the same way:
 * CDP, the page facts and the clock are passed in, so every rule below is proven without a Chromium.
 *
 * The rules, each one a test in `browser-screencast.test.ts`:
 *
 *  - **Nobody watching = no screencast.** `Page.startScreencast` is sent on the FIRST reader of a tab
 *    and `Page.stopScreencast` when the LAST one leaves. A frame that still arrives after that is
 *    dropped and never acked. Zero viewers is zero frames and zero JPEG encoding in Chromium.
 *  - **At most `MAX_FPS` (12) frames a second.** Deliveries are paced one per `FRAME_INTERVAL_MS`
 *    slot; a frame arriving inside a slot waits and is REPLACED by any newer one (the newest frame of a
 *    burst is always the one delivered, so a page that stops moving is never left showing a stale
 *    picture). The ACK — which is what lets Chromium produce the next frame — is sent only at the slot,
 *    so a 60 fps page is asked for ~12 frames a second rather than encoded 60 times and thrown away.
 *  - **Back-pressure without a queue.** A reader whose transport is behind (`sink.frame` returns false)
 *    keeps ONE pending frame, the newest, which it receives when it drains. The ack waits for every
 *    reader to have taken the current frame, but at most `MAX_ACK_WAIT_MS`: one stuck reader slows the
 *    page down for everybody up to that bound and never freezes it.
 *  - **State** (`lock`, url, title, loading, tabs, last action) is polled while watched and pushed only
 *    when it changed. A tab or browser that disappears ends its readers with `gone {reason}`.
 */

import { jpegDims, isStaleFrame } from './browser-frame-check'
import type { ViewerViewport } from './browser-viewport'

export const MAX_FPS = 12
/** One delivery slot. `ceil` so 12 slots never fit in less than a second. */
export const FRAME_INTERVAL_MS = Math.ceil(1000 / MAX_FPS)
/** The longest one slow reader may hold back the ack for everybody. */
export const MAX_ACK_WAIT_MS = 1_000
/** How often a watched tab's state is looked at (it is pushed only when it changed). */
export const STATE_POLL_MS = 500
/** A frame whose pixels are not the page's size is dropped and the screencast is re-asked after this delay… */
export const STALE_KICK_DELAY_MS = 120
/** …at most this many times in a row (a good frame resets the count), so a page that cannot render never loops. */
export const MAX_STALE_KICKS = 5
/** `Page.startScreencast` parameters (spec §1.5). */
export const SCREENCAST_PARAMS = { format: 'jpeg', quality: 60, maxWidth: 1280, maxHeight: 800, everyNthFrame: 1 } as const

/** One `Page.screencastFrame` as CDP sends it. */
export interface RawCastFrame {
  data: string
  sessionId: number
  metadata?: { deviceWidth?: number; deviceHeight?: number; timestamp?: number }
}

/** What a reader receives as `frame`. */
export interface CastFrame {
  tab: string
  seq: number
  /** Bumped every time the page viewport is re-applied: a frame of an older epoch is of an older size. */
  epoch: number
  w: number
  h: number
  /** base64 JPEG, as CDP gave it. */
  jpeg: string
  url: string
  title: string
  /** Server clock at delivery (ms). */
  at: number
}

export interface CastTab { id: string; title: string; active: boolean }

/** What a reader receives as `state`. */
export interface CastState {
  tab: string
  activeTab: string | null
  lock: 'locked' | 'unlocked' | 'none'
  url: string
  title: string
  loading: boolean
  tabs: CastTab[]
  lastAction: { kind: string; label: string; x?: number; y?: number; at: number } | null
}

export interface ScreenSink {
  /** Write one frame. `false` = the transport is behind; the hub keeps the newest for `drained()`. */
  frame(f: CastFrame): boolean
  state(s: CastState): void
  /** The stream is over (`idle`, `memory`, `tab_closed`, `no_browser`, …). Called at most once. */
  gone(reason: string): void
}

export interface Subscription {
  close(): void
  /** The transport caught up: deliver the kept frame and release the ack if it was waiting on us. */
  drained(): void
}

export type StartCast =
  | {
    ok: true; ack(sessionId: number): void; stop(): Promise<void>; resize?(v: ViewerViewport): Promise<void>
    /** The page viewport (CSS px) the cast has applied right now, when it sized one. */
    viewport?(): { w: number; h: number } | null
  }
  | { ok: false; reason: string }

type Timer = unknown

export interface ScreencastDeps {
  /** `Page.startScreencast` on the tab; frames go to `onFrame` until `stop()` (= `Page.stopScreencast`). */
  start(key: string, tab: string, onFrame: (f: RawCastFrame) => void, size?: ViewerViewport): Promise<StartCast>
  /** The tab's state now; `null` = the tab (or its browser) is gone. */
  state(key: string, tab: string): CastState | null
  /** The browser's active tab, for a reader that named none. */
  activeTab(key: string): string | null
  /** A reader came (+1) or left (−1) — the host's idle rule counts viewers. */
  viewer(key: string, delta: 1 | -1): void
  now(): number
  setTimeout(fn: () => void, ms: number): Timer
  clearTimeout(t: Timer): void
  setInterval(fn: () => void, ms: number): Timer
  clearInterval(t: Timer): void
}

interface Reader {
  /** The size this viewer asked for and when (the newest one owns the page's viewport). */
  size?: ViewerViewport
  sizedAt: number
  sink: ScreenSink
  /** The newest frame this reader has not taken yet (its transport was behind). */
  pending: CastFrame | null
  lagging: boolean
  closed: boolean
}

interface Loop {
  key: string
  tab: string
  readers: Set<Reader>
  cast: Extract<StartCast, { ok: true }> | null
  starting: Promise<void> | null
  /** Received and not delivered yet (replaced by a newer one). */
  latest: RawCastFrame | null
  /** Received frames not acked yet. */
  unacked: number[]
  oldestUnackedAt: number
  lastDeliveryAt: number
  lastAckAt: number
  flushTimer: Timer | null
  ackTimer: Timer | null
  stateTimer: Timer | null
  stateDigest: string
  lastFrame: CastFrame | null
  lastState: CastState | null
  viewport: { w: number; h: number } | null
  seq: number
  epoch: number
  /** Stale-size frames dropped since the last good one (the re-ask budget). */
  kicks: number
  kickTimer: Timer | null
  ended: boolean
}

export interface ScreencastHub {
  /** Watch a tab (`tab` null = the active one). Always resolves; a failure arrives as `gone`. */
  subscribe(key: string, tab: string | null, sink: ScreenSink, size?: ViewerViewport): Promise<Subscription>
  /** The browser stopped: end its readers with `reason`. */
  browserGone(key: string, reason: string): void
  /** The last frame size of a watched tab (CSS px of the viewport) — what input coordinates map onto. */
  viewport(key: string, tab: string): { w: number; h: number } | null
  /** Running loops (= tabs being cast). */
  loops(): number
  /** Readers across all loops. */
  readers(): number
}

const id = (key: string, tab: string) => `${key}\u0000${tab}`

export function createScreencastHub(d: ScreencastDeps): ScreencastHub {
  const loops = new Map<string, Loop>()

  function end(loop: Loop, reason: string | null): void {
    if (loop.ended) return
    loop.ended = true
    loops.delete(id(loop.key, loop.tab))
    for (const t of [loop.flushTimer, loop.ackTimer, loop.kickTimer]) if (t !== null) d.clearTimeout(t)
    if (loop.stateTimer !== null) d.clearInterval(loop.stateTimer)
    loop.flushTimer = loop.ackTimer = loop.stateTimer = loop.kickTimer = null
    const cast = loop.cast
    loop.cast = null
    for (const r of [...loop.readers]) {
      if (r.closed) continue
      r.closed = true
      d.viewer(loop.key, -1)
      if (reason !== null) { try { r.sink.gone(reason) } catch { /* reader is done */ } }
    }
    loop.readers.clear()
    if (cast) void cast.stop().catch(() => {})
  }

  /**
   * ONE ack per delivery slot. Chromium keeps a few frames in flight; acking a whole batch at once let
   * it encode ~35 frames/s for a 60 fps page (measured, S4-integration.log) while only 12 were delivered.
   * Releasing one frame per slot asks it for ~12/s. A still page drains its few unacked frames at the
   * same pace and is then at zero in flight, so the next change is sent at once.
   */
  function tryAck(loop: Loop): void {
    if (loop.ended || !loop.cast || loop.unacked.length === 0 || loop.ackTimer !== null) return
    const now = d.now()
    const waiting = [...loop.readers].some(r => r.lagging)
    const waited = now - loop.oldestUnackedAt
    if (waiting && waited < MAX_ACK_WAIT_MS) {
      loop.ackTimer = d.setTimeout(() => { loop.ackTimer = null; ackOne(loop) }, MAX_ACK_WAIT_MS - waited)
      return
    }
    const slot = loop.lastAckAt + FRAME_INTERVAL_MS - now
    if (slot > 0) {
      loop.ackTimer = d.setTimeout(() => { loop.ackTimer = null; tryAck(loop) }, slot)
      return
    }
    ackOne(loop)
  }

  function ackOne(loop: Loop): void {
    if (loop.ackTimer !== null) { d.clearTimeout(loop.ackTimer); loop.ackTimer = null }
    if (loop.ended || !loop.cast || loop.unacked.length === 0) return
    const n = loop.unacked.shift()!
    loop.lastAckAt = d.now()
    loop.oldestUnackedAt = d.now()
    try { loop.cast.ack(n) } catch { /* the browser is going */ }
    if (loop.unacked.length > 0) tryAck(loop)
  }

  function give(r: Reader, f: CastFrame): void {
    if (r.closed) return
    if (r.lagging) { r.pending = f; return }
    let ok = false
    try { ok = r.sink.frame(f) } catch { ok = true /* a throwing reader is not waited on */ }
    if (!ok) { r.lagging = true; r.pending = f }
  }

  function flush(loop: Loop): void {
    loop.flushTimer = null
    if (loop.ended || loop.latest === null) return
    const raw = loop.latest
    loop.latest = null
    const st = loop.lastState
    const w = Number(raw.metadata?.deviceWidth) || loop.viewport?.w || 0
    const h = Number(raw.metadata?.deviceHeight) || loop.viewport?.h || 0
    // A picture of the page at an OLD size (rendered before the viewport change landed, or in flight across it)
    // is never delivered: a still page would not send another one and the card would keep it for good. It is
    // acked (Chromium must go on) and the cast is re-asked, which makes Chromium render the page again.
    if (loop.cast?.resize && isStaleFrame({ jpeg: jpegDims(raw.data), meta: { w, h }, expected: loop.cast.viewport?.() ?? null }) && sizedOwner(loop)) {
      tryAck(loop)
      kick(loop)
      return
    }
    loop.kicks = 0
    if (w > 0 && h > 0) loop.viewport = { w, h }
    loop.seq += 1
    const frame: CastFrame = { tab: loop.tab, seq: loop.seq, epoch: loop.epoch, w, h, jpeg: raw.data, url: st?.url ?? '', title: st?.title ?? '', at: d.now() }
    loop.lastFrame = frame
    loop.lastDeliveryAt = d.now()
    for (const r of [...loop.readers]) give(r, frame)
    tryAck(loop)
  }

  /** The newest sized viewer: the one that owns the page's viewport. */
  function sizedOwner(loop: Loop): Reader | null {
    return [...loop.readers].filter(o => o.size && !o.closed).reduce<Reader | null>((acc, o) => (!acc || o.sizedAt > acc.sizedAt ? o : acc), null)
  }

  /**
   * Re-apply a viewport and restart the screencast. Everything captured BEFORE it is of the old size, so it is
   * forgotten here (the replay for a late viewer, the frame waiting for its slot, a lagging reader's kept
   * frame) and the epoch moves on: a frame can only ever be of the viewport of its own epoch.
   */
  async function resizeLoop(loop: Loop, size: ViewerViewport): Promise<void> {
    if (!loop.cast?.resize) return
    loop.epoch += 1
    loop.lastFrame = null
    loop.latest = null
    for (const r of loop.readers) r.pending = null
    await loop.cast.resize(size)
  }

  function kick(loop: Loop): void {
    if (loop.ended || loop.kickTimer !== null || loop.kicks >= MAX_STALE_KICKS) return
    loop.kicks += 1
    loop.kickTimer = d.setTimeout(() => {
      loop.kickTimer = null
      const owner = sizedOwner(loop)
      if (loop.ended || !owner?.size) return
      void resizeLoop(loop, owner.size).catch(() => {})
    }, STALE_KICK_DELAY_MS)
  }

  function onRaw(loop: Loop, raw: RawCastFrame): void {
    if (loop.ended || loop.readers.size === 0) return
    if (typeof raw?.data !== 'string' || typeof raw.sessionId !== 'number') return
    if (loop.unacked.length === 0) loop.oldestUnackedAt = d.now()
    loop.unacked.push(raw.sessionId)
    loop.latest = raw
    if (loop.flushTimer !== null) return
    const wait = Math.max(0, loop.lastDeliveryAt + FRAME_INTERVAL_MS - d.now())
    if (wait === 0) flush(loop)
    else loop.flushTimer = d.setTimeout(() => flush(loop), wait)
  }

  let sizeClock = 0

  function pollState(loop: Loop): boolean {
    if (loop.ended) return false
    const s = d.state(loop.key, loop.tab)
    if (s === null) { end(loop, 'tab_closed'); return false }
    const digest = JSON.stringify(s)
    if (digest === loop.stateDigest) return true
    loop.stateDigest = digest
    loop.lastState = s
    for (const r of [...loop.readers]) { if (!r.closed) { try { r.sink.state(s) } catch { /* reader is done */ } } }
    return true
  }

  function leave(loop: Loop, r: Reader): void {
    if (r.closed) return
    r.closed = true
    loop.readers.delete(r)
    d.viewer(loop.key, -1)
    if (loop.readers.size === 0) end(loop, null)
    else {
      rearmAck(loop) // a lagging reader leaving may be the one the ack waited on
      // The viewer that sized the page left: the newest remaining sized viewer takes over now.
      if (r.size && loop.cast?.resize) {
        const owner = sizedOwner(loop)
        if (owner?.size && r.sizedAt > owner.sizedAt) void resizeLoop(loop, owner.size).catch(() => {})
      }
    }
  }

  /** The reason the ack was waiting may be gone (a reader drained or left): decide again now. */
  function rearmAck(loop: Loop): void {
    if (loop.ackTimer !== null) { d.clearTimeout(loop.ackTimer); loop.ackTimer = null }
    tryAck(loop)
  }

  return {
    async subscribe(key, tabIn, sink, size) {
      const tab = tabIn ?? d.activeTab(key)
      if (!tab) { try { sink.gone('no_browser') } catch { /* */ } return { close() {}, drained() {} } }
      let loop = loops.get(id(key, tab))
      const reader: Reader = { sink, pending: null, lagging: false, closed: false, size, sizedAt: ++sizeClock }
      if (!loop) {
        const created: Loop = {
          key, tab, readers: new Set(), cast: null, starting: null, latest: null, unacked: [], oldestUnackedAt: 0,
          lastDeliveryAt: -Infinity, lastAckAt: -Infinity, flushTimer: null, ackTimer: null, stateTimer: null, stateDigest: '', lastFrame: null,
          lastState: null, viewport: null, seq: 0, epoch: 0, kicks: 0, kickTimer: null, ended: false,
        }
        loop = created
        loops.set(id(key, tab), created)
        created.readers.add(reader)
        d.viewer(key, 1)
        created.starting = (async () => {
          let started: StartCast
          try { started = await d.start(key, tab, raw => onRaw(created, raw), size) } catch { started = { ok: false, reason: 'cast_failed' } }
          if (!started.ok) { end(created, started.reason); return }
          if (created.ended || created.readers.size === 0) { void started.stop().catch(() => {}); end(created, null); return }
          created.cast = started
          if (!pollState(created)) return
          created.stateTimer = d.setInterval(() => { pollState(created) }, STATE_POLL_MS)
          tryAck(created)
        })()
        await created.starting
        if (reader.closed && !created.ended) { /* closed during start */ }
        if (created.ended) return { close() {}, drained() {} }
      } else {
        loop.readers.add(reader)
        d.viewer(key, 1)
        if (loop.starting) await loop.starting
        if (loop.ended) return { close() {}, drained() {} }
        if (size && loop.cast?.resize) {
          try { await resizeLoop(loop, size) } catch { end(loop, 'cast_failed'); return { close() {}, drained() {} } }
        }
        if (loop.lastState) { try { sink.state(loop.lastState) } catch { /* */ } }
        if (loop.lastFrame) give(reader, loop.lastFrame)
      }
      const l = loop
      return {
        close: () => leave(l, reader),
        drained: () => {
          if (reader.closed) return
          reader.lagging = false
          const p = reader.pending
          reader.pending = null
          if (p) give(reader, p)
          rearmAck(l)
        },
      }
    },
    browserGone(key, reason) {
      for (const loop of [...loops.values()]) if (loop.key === key) end(loop, reason)
    },
    viewport(key, tab) {
      return loops.get(id(key, tab))?.viewport ?? null
    },
    loops: () => loops.size,
    readers: () => { let n = 0; for (const l of loops.values()) n += l.readers.size; return n },
  }
}
