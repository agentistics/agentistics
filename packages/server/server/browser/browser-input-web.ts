/**
 * browser-input-web.ts — `WS /api/browser/input?owner=<managedId|personal>&tab=<targetId>` (NAVEGADOR S4,
 * spec §1.6): the person's pointer, keys and text onto one browser tab. The browser twin of
 * `sessions/input-web.ts`; the protocol and the per-event padlock rule are the pure
 * `browser-input-protocol.ts`, this file is only the wiring to the ONE host and the socket plumbing.
 *
 * Gates, all on the server: `index.ts` refuses the upgrade unless `localShell` + the browser switch +
 * same Origin (CSWSH) + the caller is NOT a session (`browser-caller.ts`, socket-identified, fail-closed)
 * + a live browser for the owner + the ceiling. Then EVERY event is checked against the padlock at the
 * moment it arrives: a session's browser accepts input only while the person holds it (unlocked).
 * Nothing is logged — a typed password goes straight to `Input.dispatch*`.
 */
import { createBrowserInputChannel, type BrowserInputChannel } from './browser-input-protocol'
import { browserHost, browserLocks, type BrowserWebOpts } from './browser-web'
import { browserScreencastHub } from './browser-stream-web'
import { ownerKey, type BrowserOwner } from './browser-spec'

export const MAX_BROWSER_INPUT_SOCKETS = 16

export interface BrowserInputState {
  readonly key: string
  readonly owner: BrowserOwner
  /** The tab the socket was opened for; `null` = whichever tab is active at each event. */
  readonly tab: string | null
  readonly opts: BrowserWebOpts
  channel: BrowserInputChannel | null
}

interface InputSocket {
  data: { browserInput?: BrowserInputState }
  send(data: string): unknown
}

let openSockets = 0

export function createBrowserInputState(opts: BrowserWebOpts, owner: BrowserOwner, tab: string | null): BrowserInputState {
  return { key: ownerKey(owner), owner, tab, opts, channel: null }
}

export function browserInputAtCapacity(): boolean {
  return openSockets >= MAX_BROWSER_INPUT_SOCKETS
}

export function browserInputSocketCount(): number {
  return openSockets
}

export function openBrowserInputSocket(ws: InputSocket): void {
  const st = ws.data.browserInput
  if (!st) return
  openSockets++
  const host = browserHost(st.opts)
  const locks = browserLocks(st.opts)
  const hub = browserScreencastHub(st.opts)
  const tabNow = (): string | null => {
    const f = host.streamFacts(st.key)
    if (!f) return null
    const t = st.tab ?? f.activeTab
    return t && f.tabs.some(x => x.targetId === t) ? t : null
  }
  st.channel = createBrowserInputChannel({
    // THE rule: a session's browser is the person's only while unlocked; the personal one always is.
    allowed: () => st.owner.kind === 'personal' || locks.view(st.key).mode === 'unlocked',
    viewport: async () => {
      const tab = tabNow()
      const ah = host.actionHost(st.key)
      const cdp = host.cdpOf(st.key)
      if (!tab || !ah || !cdp) return null
      const seen = hub.viewport(st.key, tab)
      if (seen) return seen
      try {
        const sid = await ah.sessionFor(tab)
        const m = await cdp.send<{ cssLayoutViewport?: { clientWidth?: number; clientHeight?: number } }>('Page.getLayoutMetrics', {}, sid)
        const w = Number(m.cssLayoutViewport?.clientWidth)
        const h = Number(m.cssLayoutViewport?.clientHeight)
        return w > 0 && h > 0 ? { w, h } : null
      } catch { return null }
    },
    dispatch: async (cmds) => {
      const tab = tabNow()
      const ah = host.actionHost(st.key)
      const cdp = host.cdpOf(st.key)
      if (!tab || !ah || !cdp) return false
      const sid = await ah.sessionFor(tab)
      for (const c of cmds) await cdp.send(c.method, c.params, sid)
      return true
    },
    noteInput: () => {
      host.touch(st.key)
      if (st.owner.kind === 'session') locks.personInput(st.key)
    },
    emit: (ack) => { try { ws.send(JSON.stringify(ack)) } catch { /* socket gone */ } },
    now: () => Date.now(),
  })
}

export function onBrowserInputMessage(ws: InputSocket, raw: string | Buffer): void {
  const st = ws.data.browserInput
  if (!st?.channel) return
  st.channel.submit(typeof raw === 'string' ? raw : raw.toString('utf8'))
}

export function closeBrowserInputSocket(ws: InputSocket): void {
  const st = ws.data.browserInput
  if (!st || !st.channel) return
  st.channel = null
  openSockets = Math.max(0, openSockets - 1)
}
