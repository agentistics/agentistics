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
/** …this many fast retries before backing off (a good frame resets the count). */
export const MAX_STALE_KICKS = 5
/** Once the fast retries are exhausted, keep recovering a still page at a bounded, slower cadence. */
export const STALE_BACKOFF_MS = 5_000
/**
 * JPEG quality of the MOVING picture (NAVEGADOR.FLUIDEZ-NITIDEZ). Measured on the real page set
 * (leader/qa/navegador-fluidez.md): bytes per frame grow steeply past this point while motion hides the difference.
 */
export const QUALITY_MOTION = 70
/** Quality of the ONE sharp frame taken once the page is still (a screenshot, not a screencast frame). */
export const QUALITY_STILL = 90
/** No new frame for this long = the page is still: replace the last motion frame with a sharp one. */
export const STILL_MS = 350
/** At most one sharp frame per this interval (a blinking caret must not become a screenshot loop). */
export const SHARP_MIN_INTERVAL_MS = 1_500
/**
 * A screenshot makes Chromium re-send the still page through the screencast. Measured (r2, headless, 1240x700@1.75 and
 * 1280x720@1, 12 screenshots): EVERY time the same bytes as the last screencast frame (13–122 ms after the shot
 * starts), and at a dense size sometimes (1 of 6) one frame at the screenshot's PHYSICAL size first. Those are the
 * echoes, and they are told apart EXACTLY, never by counting: the same bytes are the same pixels (acked, never shown,
 * never "motion"); a frame of another size than the cast's, inside this window after a screenshot, is HELD — dropped
 * once a normal-size frame follows it (that one is newer), and otherwise answered with ONE fresh screenshot, then shown
 * as it is. Any other frame is the page changing and is shown at once: the worst case is one extra screenshot or one
 * extra frame, never a stale screen (QA r1: a click repainting once ~0–250 ms after the sharp frame was lost for good).
 */
export const SHARP_ECHO_MS = 300
/** `Page.startScreencast` parameters (spec §1.5); `maxWidth`/`maxHeight` are replaced by the viewer's plan. */
export const SCREENCAST_PARAMS = { format: 'jpeg', quality: QUALITY_MOTION, maxWidth: 1280, maxHeight: 800, everyNthFrame: 1 } as const

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
  /** Unique across cast starts/tab switches and bumped when the page viewport is re-applied. */
  epoch: number
  w: number
  h: number
  /** base64 JPEG, as CDP gave it. */
  jpeg: string
  url: string
  title: string
  /** Server clock at delivery (ms). */
  at: number
  /** The sharp still frame (a screenshot at `QUALITY_STILL`) that replaced the last motion frame. */
  sharp?: true
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
    /** A sharp picture of the page as it is now (base64 JPEG), or null. Absent = no sharp-when-still. */
    sharp?(): Promise<string | null>
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
  /** Armed after a motion frame is delivered; fires the sharp still frame. */
  stillTimer: Timer | null
  /** Bumped by every raw frame: a screenshot taken while it moved again is discarded. */
  motion: number
  lastSharpAt: number
  /** The data of the last delivered screencast frame (an identical one is acked, never re-sent). */
  lastRawData: string | null
  /** The JPEG size the cast delivers its frames at (a frame of another size near a screenshot is its physical echo). */
  castDims: { w: number; h: number } | null
  /** Frames until this instant may be echoes of a screenshot (Infinity while one is being taken; null = none). */
  echoUntil: number | null
  /** An other-size frame held in that window; nothing newer has arrived since. */
  echoRaw: RawCastFrame | null
  echoTimer: Timer | null
  /** The fresh screenshot a held frame earns was already spent since the last delivered frame. */
  reshot: boolean
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
  // Survives loop teardown/reconnect and tab switches: a different capture never reuses (epoch, seq).
  // Seed from the server clock so a reconnect after a server restart also moves forward.
  let epochClock = d.now()
  /** Held other-size frames shown as a last resort (they do not set the cast's size nor reset the fresh screenshot). */
  const forced = new WeakSet<RawCastFrame>()

  function end(loop: Loop, reason: string | null): void {
    if (loop.ended) return
    loop.ended = true
    loops.delete(id(loop.key, loop.tab))
    for (const t of [loop.flushTimer, loop.ackTimer, loop.kickTimer, loop.stillTimer, loop.echoTimer]) if (t !== null) d.clearTimeout(t)
    if (loop.stateTimer !== null) d.clearInterval(loop.stateTimer)
    loop.flushTimer = loop.ackTimer = loop.stateTimer = loop.kickTimer = loop.stillTimer = loop.echoTimer = null
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
    if (loop.ended || loop.latest === null || !loop.cast) return
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
    if (loop.kickTimer !== null) { d.clearTimeout(loop.kickTimer); loop.kickTimer = null }
    // The same picture again (a repaint that changed no pixel, or the one a screenshot provoked): ack, never re-send.
    if (raw.data === loop.lastRawData && loop.lastFrame) { tryAck(loop); return }
    loop.lastRawData = raw.data
    // A held other-size frame shown as a last resort is not the cast's size and earns no new screenshot.
    if (!forced.has(raw)) { loop.castDims = jpegDims(raw.data); loop.reshot = false }
    if (w > 0 && h > 0) loop.viewport = { w, h }
    loop.seq += 1
    const frame: CastFrame = { tab: loop.tab, seq: loop.seq, epoch: loop.epoch, w, h, jpeg: raw.data, url: st?.url ?? '', title: st?.title ?? '', at: d.now() }
    loop.lastFrame = frame
    loop.lastDeliveryAt = d.now()
    for (const r of [...loop.readers]) give(r, frame)
    tryAck(loop)
    armStill(loop)
  }

  /**
   * Sharp when still: motion frames are encoded at `QUALITY_MOTION`; once nothing new arrived for `STILL_MS`, one
   * screenshot at `QUALITY_STILL` replaces the last motion frame. Discarded if the page moved meanwhile, if the
   * viewport changed (epoch), or if it cannot be told to be of the page's current size.
   */
  function armStill(loop: Loop): void {
    if (loop.stillTimer !== null) d.clearTimeout(loop.stillTimer)
    loop.stillTimer = null
    if (!loop.cast?.sharp) return
    const wait = Math.max(STILL_MS, loop.lastSharpAt + SHARP_MIN_INTERVAL_MS - d.now())
    loop.stillTimer = d.setTimeout(() => { loop.stillTimer = null; void takeSharp(loop) }, wait)
  }

  /** `again`: the fresh screenshot a held other-size frame earns (the frame on screen is already a sharp one). */
  async function takeSharp(loop: Loop, again = false): Promise<void> {
    const base = loop.lastFrame
    if (loop.ended || !loop.cast?.sharp || !base || (base.sharp && !again)) return
    const motion = loop.motion
    loop.lastSharpAt = d.now()
    loop.echoUntil = Infinity
    loop.echoRaw = null
    let jpeg: string | null = null
    try { jpeg = await loop.cast.sharp() } catch { jpeg = null }
    if (loop.ended) return
    const ok = jpeg !== null && loop.motion === motion && loop.lastFrame === base && loop.epoch === base.epoch && loop.echoUntil === Infinity
      && !isStaleFrame({ jpeg: jpegDims(jpeg), meta: { w: base.w, h: base.h }, expected: loop.cast?.viewport?.() ?? null })
    if (!ok) {
      // Not shown. A real frame that arrived meanwhile was delivered already; a held one is the page's newest picture.
      const held = loop.echoUntil === Infinity ? loop.echoRaw : null
      clearEcho(loop)
      if (held) deliverHeld(loop, held)
      return
    }
    loop.seq += 1
    const frame: CastFrame = { ...base, seq: loop.seq, jpeg: jpeg!, at: d.now(), sharp: true }
    loop.lastFrame = frame
    for (const r of [...loop.readers]) give(r, frame)
    // A held frame stays held: it is judged when the window closes, against what arrives after it.
    loop.echoUntil = d.now() + SHARP_ECHO_MS
    loop.echoTimer = d.setTimeout(() => { loop.echoTimer = null; closeEcho(loop) }, SHARP_ECHO_MS)
  }

  /** The echo window closed. Nothing held = nothing to do; a held frame nothing followed may be the page changing. */
  function closeEcho(loop: Loop): void {
    const held = loop.echoRaw
    clearEcho(loop)
    if (!held || loop.ended) return
    if (!loop.reshot) { loop.reshot = true; void takeSharp(loop, true); return }
    deliverHeld(loop, held)
  }

  function clearEcho(loop: Loop): void {
    if (loop.echoTimer !== null) { d.clearTimeout(loop.echoTimer); loop.echoTimer = null }
    loop.echoUntil = null
    loop.echoRaw = null
    tryAck(loop)
  }

  function deliverHeld(loop: Loop, raw: RawCastFrame): void {
    forced.add(raw)
    deliverRaw(loop, raw)
  }

  /** Near a screenshot, a frame of another size than the cast's is the screenshot's physical render (or not: held). */
  function otherSize(loop: Loop, raw: RawCastFrame): boolean {
    const a = loop.castDims
    const b = a ? jpegDims(raw.data) : null
    return !!(a && b && (a.w !== b.w || a.h !== b.h))
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
    loop.epoch = ++epochClock
    loop.lastFrame = null
    loop.latest = null
    loop.lastRawData = null
    if (loop.stillTimer !== null) { d.clearTimeout(loop.stillTimer); loop.stillTimer = null }
    if (loop.echoTimer !== null) { d.clearTimeout(loop.echoTimer); loop.echoTimer = null }
    loop.echoUntil = null; loop.echoRaw = null; loop.castDims = null; loop.reshot = false
    for (const r of loop.readers) r.pending = null
    await loop.cast.resize(size)
  }

  function kick(loop: Loop): void {
    if (loop.ended || loop.kickTimer !== null) return
    const delay = loop.kicks < MAX_STALE_KICKS ? STALE_KICK_DELAY_MS : STALE_BACKOFF_MS
    loop.kickTimer = d.setTimeout(() => {
      loop.kickTimer = null
      const owner = sizedOwner(loop)
      if (loop.ended || !owner?.size) return
      loop.kicks = Math.min(MAX_STALE_KICKS, loop.kicks + 1)
      void resizeLoop(loop, owner.size).catch(() => {}).then(() => { if (loop.kicks > 0) kick(loop) })
    }, delay)
  }

  function onRaw(loop: Loop, raw: RawCastFrame): void {
    if (loop.ended || loop.readers.size === 0) return
    if (typeof raw?.data !== 'string' || typeof raw.sessionId !== 'number') return
    if (loop.unacked.length === 0) loop.oldestUnackedAt = d.now()
    loop.unacked.push(raw.sessionId)
    const nearShot = loop.echoUntil !== null && d.now() < loop.echoUntil
    // The very picture on screen again, with nothing newer waiting: nothing changed (a screenshot's echo, a repaint
    // of no pixel). Acked, and not motion — it must not void a screenshot or re-arm one. A frame waiting for its slot
    // makes this a real change back, which goes the normal way (the slot then sends it… or dedupes it in `flush`).
    if (raw.data === loop.lastRawData && loop.lastFrame && loop.latest === null) {
      if (nearShot) loop.echoRaw = null // a newer picture at the cast's size: a held other-size frame is superseded
      tryAck(loop)
      return
    }
    if (nearShot && otherSize(loop, raw)) { loop.echoRaw = raw; tryAck(loop); return }
    if (nearShot) loop.echoRaw = null // superseded by this newer one
    deliverRaw(loop, raw)
  }

  function deliverRaw(loop: Loop, raw: RawCastFrame): void {
    loop.motion += 1
    if (loop.stillTimer !== null) { d.clearTimeout(loop.stillTimer); loop.stillTimer = null }
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
          lastState: null, viewport: null, seq: 0, epoch: ++epochClock, kicks: 0, kickTimer: null,
          stillTimer: null, motion: 0, lastSharpAt: -Infinity, lastRawData: null,
          castDims: null, echoUntil: null, echoRaw: null, echoTimer: null, reshot: false, ended: false,
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
          flush(created) // frames can arrive before startScreencast resolves; validate against the applied viewport
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
