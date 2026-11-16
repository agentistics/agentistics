/**
 * browser-stream-web.ts — `GET /api/browser/stream?owner=<managedId|personal>&tab=<targetId>` (NAVEGADOR
 * S4, spec §1.5): the live screen of one browser tab, as SSE. It rides the tab's ONE WebSocket through
 * `stream-mux.ts` (`MUX_EXACT`), never a bare EventSource.
 *
 * Events: `open {owner, tab}`, `frame {tab, seq, w, h, jpeg, url, title, at}`, `state {…}` (padlock, url,
 * title, loading, tabs, last action with its x/y — the caption and the ring), `gone {reason}`.
 *
 * The rules live in the pure hub (`browser-screencast.ts`): nobody watching = `Page.stopScreencast`;
 * ≤ 12 frames/s; a reader whose transport is behind keeps only the newest frame. This file is the wiring
 * to the ONE host and the SSE plumbing, whose back-pressure signal is the stream's own queue: with a
 * high-water mark of one chunk, `desiredSize <= 0` means the reader has not taken the last one, and
 * `pull` is the moment it did.
 *
 * Reading a screen never starts a browser: no live browser ⇒ 404 `no_browser`.
 */
import { createScreencastHub, SCREENCAST_PARAMS, type CastState, type ScreencastHub, type ScreenSink, type Subscription } from './browser-screencast'
import { browserHost, browserLocks, type BrowserWebOpts } from './browser-web'
import { ownerKey, statusTitle, type BrowserOwner } from './browser-spec'

/** Concurrent screen streams for the whole process (each holds a socket and, shared, a cast). */
export const MAX_BROWSER_STREAMS = 32
const KEEPALIVE_MS = 15_000
const MAX_URL = 2_048

let hub: ScreencastHub | null = null

/** `owner` query → the browser's owner, or null. */
export function parseStreamOwner(raw: string | null): BrowserOwner | null {
  if (raw === 'personal') return { kind: 'personal' }
  if (typeof raw === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(raw)) return { kind: 'session', managedId: raw }
  return null
}

export function parseStreamTab(raw: string | null): string | null | false {
  if (raw === null || raw === '') return null
  return /^[A-Za-z0-9_-]{1,64}$/.test(raw) ? raw : false
}

/** The ONE screencast hub, bound to the ONE browser host. */
export function browserScreencastHub(opts: BrowserWebOpts): ScreencastHub {
  if (hub) return hub
  const host = browserHost(opts)
  const locks = browserLocks(opts)
  const h = createScreencastHub({
    start: async (key, tab, onFrame) => {
      const ah = host.actionHost(key)
      const cdp = host.cdpOf(key)
      if (!ah || !cdp) return { ok: false, reason: 'no_browser' }
      if (!ah.tabs().some(t => t.targetId === tab)) return { ok: false, reason: 'tab_closed' }
      let sid: string
      try { sid = await ah.sessionFor(tab) } catch { return { ok: false, reason: 'tab_closed' } }
      const off = host.onCdpEvent(key, (ev) => {
        if (ev.method === 'Page.screencastFrame' && ev.sessionId === sid) onFrame(ev.params)
      })
      try {
        await cdp.send('Page.startScreencast', { ...SCREENCAST_PARAMS }, sid)
      } catch {
        off()
        return { ok: false, reason: 'cast_failed' }
      }
      return {
        ok: true,
        ack: (n) => { void cdp.send('Page.screencastFrameAck', { sessionId: n }, sid).catch(() => {}) },
        stop: async () => { off(); await cdp.send('Page.stopScreencast', {}, sid).catch(() => {}) },
      }
    },
    state: (key, tab) => {
      const f = host.streamFacts(key)
      if (!f) return null
      const t = f.tabs.find(x => x.targetId === tab)
      if (!t) return null
      const la = f.lastAction
      const s: CastState = {
        tab,
        activeTab: f.activeTab,
        lock: f.owner.kind === 'session' ? locks.view(key).mode : 'none',
        url: t.url.slice(0, MAX_URL),
        title: statusTitle(t.title),
        loading: t.loading,
        tabs: f.tabs.map(x => ({ id: x.targetId, title: statusTitle(x.title), active: x.active })),
        lastAction: la ? { kind: la.kind, label: statusTitle(la.label), ...(la.x !== undefined ? { x: la.x } : {}), ...(la.y !== undefined ? { y: la.y } : {}), at: la.at } : null,
      }
      return s
    },
    activeTab: (key) => host.streamFacts(key)?.activeTab ?? null,
    viewer: (key, delta) => { if (delta > 0) host.addViewer(key); else host.removeViewer(key) },
    now: () => Date.now(),
    setTimeout: (fn, ms) => { const t = setTimeout(fn, ms); (t as any).unref?.(); return t },
    clearTimeout: (t) => clearTimeout(t as ReturnType<typeof setTimeout>),
    setInterval: (fn, ms) => { const t = setInterval(fn, ms); (t as any).unref?.(); return t },
    clearInterval: (t) => clearInterval(t as ReturnType<typeof setInterval>),
  })
  host.onStopped((key, reason) => h.browserGone(key, reason))
  hub = h
  return h
}

/** For the route: is there a live browser to watch? */
export function browserStreamTarget(opts: BrowserWebOpts, owner: BrowserOwner): string | null {
  const key = ownerKey(owner)
  return browserHost(opts).actionHost(key) ? key : null
}

export function browserStreamAtCapacity(opts: BrowserWebOpts): boolean {
  return browserScreencastHub(opts).readers() >= MAX_BROWSER_STREAMS
}

const sse = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`

/** The SSE body for one tab's screen. Cleanup is tied to `signal` (the browser left). */
export function openBrowserStream(opts: BrowserWebOpts, key: string, tab: string | null, signal: AbortSignal): ReadableStream<Uint8Array> {
  const h = browserScreencastHub(opts)
  const enc = new TextEncoder()
  let sub: Subscription | null = null
  let keepalive: ReturnType<typeof setInterval> | null = null
  let closed = false
  const teardown = () => {
    closed = true
    if (keepalive !== null) { clearInterval(keepalive); keepalive = null }
    sub?.close()
    sub = null
  }
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const push = (chunk: string) => {
        if (closed) return
        try { controller.enqueue(enc.encode(chunk)) } catch { teardown() }
      }
      const end = () => {
        if (closed) return
        teardown()
        try { controller.close() } catch { /* already closed */ }
      }
      if (signal.aborted) { end(); return }
      push(sse('open', { owner: key, tab }))
      keepalive = setInterval(() => push(': keepalive\n\n'), KEEPALIVE_MS)
      const sink: ScreenSink = {
        // Back-pressure: one chunk not yet taken by the reader ⇒ behind; the hub keeps the newest frame.
        frame: (f) => {
          if (closed) return true
          if ((controller.desiredSize ?? 1) <= 0) return false
          push(sse('frame', f))
          return true
        },
        state: (s) => push(sse('state', s)),
        gone: (reason) => { push(sse('gone', { reason })); end() },
      }
      signal.addEventListener('abort', end, { once: true })
      const s = await h.subscribe(key, tab, sink)
      if (closed) s.close()
      else sub = s
    },
    pull() {
      sub?.drained()
    },
    cancel() {
      teardown()
    },
  }, { highWaterMark: 1 })
}
