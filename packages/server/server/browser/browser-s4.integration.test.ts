/**
 * NAVEGADOR S4 — the screen and the person's input against a REAL headless Chromium, through the REAL
 * wiring (`browserHost` / `browserScreencastHub` / `openBrowserStream` / the input socket). Opt-in
 * (`BROWSER_INTEGRATION=1`), one browser, stopped at the end. Run alone in its own bun process:
 *
 *   agentop run --rm -- env BROWSER_INTEGRATION=1 AGENTISTICS_BROWSER_BIN=<headless shell> \
 *     bun test packages/server/server/browser/browser-s4.integration.test.ts
 *
 * Proves, measured: (1) nobody watching ⇒ ZERO `Page.screencastFrame` from Chromium, before and after a
 * viewer; (2) a 60 fps page reaches a viewer at ≤ 12 fps; (3) a reader that does not read never makes
 * the server queue (it gets the newest frame, the others keep going); (4) input is refused while locked
 * and reaches the page while unlocked; (5) click → frame latency, printed as `S4-LATENCY {...}`.
 */
import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runAction } from './browser-actions'
import { parseActionArgs } from './browser-action-spec'
import { browserHost, browserLocks, type BrowserWebOpts } from './browser-web'
import { browserScreencastHub, openBrowserStream } from './browser-stream-web'
import { closeBrowserInputSocket, createBrowserInputState, onBrowserInputMessage, openBrowserInputSocket } from './browser-input-web'
import { MAX_FPS } from './browser-screencast'

const RUN = process.env.BROWSER_INTEGRATION === '1'
const d = RUN ? describe : describe.skip
const log = (...a: unknown[]) => console.log('[browser-s4]', ...a)

const dataDir = mkdtempSync(join(tmpdir(), 'browser-s4-'))
const opts: BrowserWebOpts = { dataDir, agentisticsPorts: [1, 2] }
const MANAGED = 's4it'
const KEY = `s-${MANAGED}`

const animated = `<!doctype html><title>Anim</title><body style="margin:0"><canvas id=c width=1280 height=800></canvas>
<script>const c=document.getElementById('c').getContext('2d');let n=0;function f(){n++;c.fillStyle='hsl('+(n%360)+',80%,50%)';c.fillRect(0,0,1280,800);requestAnimationFrame(f)}f()</script>`
const clicker = `<!doctype html><title>Click</title><body style="margin:0">
<button id=b style="position:fixed;left:0;top:0;width:100vw;height:100vh;border:0;background:white"
 onclick="window.clicks=(window.clicks||0)+1;this.style.background=this.style.background==='black'?'white':'black'">x</button>
<input id=t style="position:fixed;left:10px;bottom:10px;width:200px" onclick="event.stopPropagation()">`

const app = RUN ? Bun.serve({
  port: 0, hostname: '127.0.0.1',
  fetch(req) {
    const p = new URL(req.url).pathname
    return new Response(p === '/anim' ? animated : clicker, { headers: { 'content-type': 'text/html' } })
  },
}) : null

async function act(action: 'navigate' | 'evaluate', body: Record<string, unknown>) {
  const p = parseActionArgs(action, body)
  if (!p.ok) throw new Error(p.sentence)
  const h = browserHost(opts).actionHost(KEY)
  if (!h) throw new Error('no browser')
  return runAction(h, p.args)
}

/** Raw `Page.screencastFrame` events Chromium sent, whoever listens — the measure of "zero frames". */
function rawFrameCounter() {
  let n = 0
  const off = browserHost(opts).onCdpEvent(KEY, (ev) => { if (ev.method === 'Page.screencastFrame') n++ })
  return { count: () => n, off }
}

/** Read one SSE stream in the background, collecting events. */
function reader(tab: string | null, opts2: { read?: boolean } = {}) {
  const ac = new AbortController()
  const body = openBrowserStream(opts, KEY, tab, ac.signal)
  const events: Array<{ event: string; data: any; at: number }> = []
  const waiters: Array<() => void> = []
  const r = body.getReader()
  let buf = ''
  const dec = new TextDecoder()
  const pump = async () => {
    for (;;) {
      const { done, value } = await r.read()
      if (done) return
      buf += dec.decode(value, { stream: true })
      let i
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, i); buf = buf.slice(i + 2)
        const ev = /^event: (.*)$/m.exec(block)?.[1]
        const data = /^data: (.*)$/m.exec(block)?.[1]
        if (ev && data) { events.push({ event: ev, data: JSON.parse(data), at: performance.now() }); for (const w of waiters.splice(0)) w() }
      }
    }
  }
  const go = () => { void pump().catch(() => {}) }
  if (opts2.read !== false) go()
  return {
    events, frames: () => events.filter(e => e.event === 'frame'), close: () => ac.abort(), go,
    next: (pred: (e: { event: string; data: any; at: number }) => boolean, ms = 3000) => new Promise<{ event: string; data: any; at: number } | null>((res) => {
      const start = events.length
      const t = setTimeout(() => res(null), ms)
      const check = () => { const hit = events.slice(start).find(pred); if (hit) { clearTimeout(t); res(hit) } else waiters.push(check) }
      check()
    }),
  }
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const pct = (xs: number[], p: number) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]! }

afterAll(async () => {
  if (RUN) { await browserHost(opts).stopAll('server-stop'); app?.stop(true) }
  rmSync(dataDir, { recursive: true, force: true })
})

d('S4 against a real Chromium', () => {
  test('start a session browser on an animated (≈60 fps) page', async () => {
    const r = await browserHost(opts).start({ kind: 'session', managedId: MANAGED })
    expect(r.ok).toBe(true)
    const nav = await act('navigate', { url: `http://127.0.0.1:${app!.port}/anim` })
    expect(nav.ok).toBe(true)
  }, 30_000)

  test('nobody watching ⇒ zero frames; a viewer gets frames at ≤ 12 fps; the last viewer leaving ⇒ zero again', async () => {
    // Record the screencast commands actually sent. Without acks Chromium stops producing by itself, so
    // "zero frames afterwards" alone would not prove the cast was STOPPED (measured: a never-stop mutant
    // passed it) — the command must be sent.
    const cdp = browserHost(opts).cdpOf(KEY)!
    const sentMethods: string[] = []
    const origSend = cdp.send.bind(cdp)
    ;(cdp as any).send = (method: string, ...rest: unknown[]) => { if (method.startsWith('Page.') && method.includes('creencast')) sentMethods.push(method); return (origSend as any)(method, ...rest) }
    const raw = rawFrameCounter()
    await sleep(1500)
    const before = raw.count()
    const a = reader(null)
    await sleep(500) // let the cast start
    const startedAt = raw.count()
    const fa = a.frames().length
    await sleep(3000)
    const delivered = a.frames().length - fa
    const rawDuring = raw.count() - startedAt
    a.close()
    await sleep(400) // in-flight frames of the moment of leaving
    const afterClose = raw.count()
    await sleep(2500)
    const after = raw.count() - afterClose
    raw.off()
    const fpsDelivered = delivered / 3
    const fpsRaw = rawDuring / 3
    log(JSON.stringify({ before, delivered, fpsDelivered, rawDuring, fpsRaw, after, loops: browserScreencastHub(opts).loops() }))
    console.log(`S4-FPS ${JSON.stringify({ before, fpsDelivered, fpsRaw, afterLastViewer: after })}`)
    expect(before).toBe(0)
    expect(delivered).toBeGreaterThan(10)
    expect(fpsDelivered).toBeLessThanOrEqual(MAX_FPS + 0.34)
    expect(fpsRaw).toBeLessThanOrEqual(MAX_FPS + 1) // Chromium is ASKED for ~12/s (acks paced), not encoding 60 and thrown away
    expect(after).toBe(0)
    expect(browserScreencastHub(opts).loops()).toBe(0)
    expect(sentMethods[0]).toBe('Page.startScreencast')
    expect(sentMethods.at(-1)).toBe('Page.stopScreencast')
    expect(sentMethods.filter(m => m === 'Page.startScreencast').length).toBe(1)
    ;(cdp as any).send = origSend
  }, 30_000)

  test('back-pressure: a reader that never reads holds one frame, not a queue; another reader keeps going', async () => {
    const stuck = reader(null, { read: false })
    const live = reader(null)
    await sleep(3000)
    const liveFrames = live.frames().length
    stuck.go() // now read what the stuck one kept
    await sleep(150)
    const stuckFrames = stuck.frames().length
    log(JSON.stringify({ liveFrames, stuckFramesWhenRead: stuckFrames }))
    console.log(`S4-BACKPRESSURE ${JSON.stringify({ liveFramesIn3s: liveFrames, stuckReaderFramesOnDrain: stuckFrames })}`)
    expect(liveFrames).toBeGreaterThanOrEqual(2) // the stuck reader slows the ack at most MAX_ACK_WAIT_MS
    expect(stuckFrames).toBeLessThanOrEqual(3) // open + at most the queued chunk + the kept newest (no backlog)
    stuck.close(); live.close()
    await sleep(300)
    expect(browserScreencastHub(opts).loops()).toBe(0)
  }, 30_000)

  test('input: refused while LOCKED (the model drives), reaches the page while UNLOCKED; click → frame latency', async () => {
    await act('navigate', { url: `http://127.0.0.1:${app!.port}/click` })
    const locks = browserLocks(opts)
    const acks: any[] = []
    const ws = { data: { browserInput: createBrowserInputState(opts, { kind: 'session', managedId: MANAGED }, null) }, send: (s: string) => { acks.push(JSON.parse(s)) } }
    openBrowserInputSocket(ws)
    const clicks = async () => Number(((await act('evaluate', { expression: 'window.clicks||0' })) as any).value ?? 0)
    const send = (o: Record<string, unknown>) => onBrowserInputMessage(ws, JSON.stringify(o))
    let seq = 0
    const click = () => { send({ seq: ++seq, op: 'pointer', type: 'down', x: 0.5, y: 0.4, button: 'left' }); send({ seq: ++seq, op: 'pointer', type: 'up', x: 0.5, y: 0.4, button: 'left' }) }

    expect(locks.view(KEY).mode).toBe('locked')
    click()
    send({ seq: ++seq, op: 'text', text: 'secret' })
    await sleep(300)
    expect(acks.map(a => a.reason)).toEqual(['locked', 'locked', 'locked'])
    expect(await clicks()).toBe(0)

    locks.setLock(KEY, 'unlocked', 'person')
    const screen = reader(null)
    await screen.next(e => e.event === 'frame', 5000)
    await sleep(300)
    const lat: number[] = []
    for (let i = 0; i < 20; i++) {
      const lastSeq = screen.frames().at(-1)?.data.seq ?? 0
      const t0 = performance.now()
      click()
      const f = await screen.next(e => e.event === 'frame' && e.data.seq > lastSeq, 3000)
      if (f) lat.push(f.at - t0)
      await sleep(250)
    }
    await sleep(200)
    const n = await clicks()
    expect(n).toBe(20)
    expect(acks.slice(3).every(a => a.ok === true)).toBe(true)
    const stats = { n: lat.length, minMs: Math.round(Math.min(...lat)), p50Ms: Math.round(pct(lat, 50)), p90Ms: Math.round(pct(lat, 90)), maxMs: Math.round(Math.max(...lat)) }
    console.log(`S4-LATENCY ${JSON.stringify(stats)}`)
    expect(lat.length).toBe(20)

    // Handing it back: the very next event is refused, at the server.
    locks.setLock(KEY, 'locked', 'person')
    const before = acks.length
    click()
    await sleep(300)
    expect(acks.slice(before).map(a => a.reason)).toEqual(['locked', 'locked'])
    expect(await clicks()).toBe(20)
    closeBrowserInputSocket(ws)
    screen.close()
  }, 60_000)

  test('the browser stopping ends its screen with gone {reason}', async () => {
    const s = reader(null)
    await s.next(e => e.event === 'state', 3000)
    const gone = s.next(e => e.event === 'gone', 8000) // armed BEFORE the stop: the event lands during it
    await browserHost(opts).stop(KEY, 'requested')
    const g = await gone
    expect(g?.data).toEqual({ reason: 'requested' })
  }, 30_000)
})
