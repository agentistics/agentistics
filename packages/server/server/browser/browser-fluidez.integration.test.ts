/**
 * NAVEGADOR.FLUIDEZ-NITIDEZ — before/after probe over a REAL headless Chromium, through the real screencast hub.
 * Opt-in (one file per process), it writes its table and frames to FLUIDEZ_OUT:
 *
 *   BROWSER_INTEGRATION=1 FLUIDEZ_OUT=/abs/dir agentop run --rm -- bun test packages/server/server/browser/browser-fluidez.integration.test.ts
 *
 * Modes: `before` = what main sent (page at the viewer DPR, frame captured at CSS pixels, quality 60, no still frame);
 * `after` = `createViewportCast` (physical-pixel plan, motion quality, sharp still frame). Per surface it measures
 * delivered fps and bytes while scrolling, input -> next frame latency on a still page, the client's JPEG decode time,
 * the sharpness of the still picture against a lossless reference shown at the same physical size (PSNR), and the
 * browser's RSS. Every number in leader/qa/navegador-fluidez.md comes from here.
 */
import { afterAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readMemory } from '../sessions/memory-probe'
import { createBrowserHost } from './browser-host'
import { runAction } from './browser-actions'
import { createScreencastHub, type CastFrame, type StartCast } from './browser-screencast'
import { jpegDims } from './browser-frame-check'
import { clampViewport, createViewportCast, type ViewerViewport } from './browser-viewport'

const RUN = process.env.BROWSER_INTEGRATION === '1'
const d = RUN ? describe : describe.skip
const OUT = process.env.FLUIDEZ_OUT ?? join(tmpdir(), 'fluidez-out')
const dataDir = mkdtempSync(join(tmpdir(), 'browser-fluidez-'))
afterAll(() => { rmSync(dataDir, { recursive: true, force: true }) })
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

const lorem = 'O navegador interno mostra a página que o modelo usa. Texto pequeno precisa ser legível em tela densa: 0123456789 — ação, conclusão, órgão. '
const page = `<!doctype html><meta charset=utf-8><title>fluidez</title>
<body style="margin:0;font:13px system-ui,sans-serif;color:#222;background:#fff">
<header id=h style="position:sticky;top:0;background:#1d4ed8;color:#fff;padding:10px 16px;font-size:15px">Cabeçalho · agentistics · 12px/13px/15px</header>
${Array.from({ length: 60 }, (_, i) => `<section style="padding:8px 16px;border-bottom:1px solid #ddd"><h3 style="margin:4px 0;font-size:15px">Seção ${i + 1}</h3><p style="margin:2px 0;font-size:12px">${lorem.repeat(3)}</p><div style="height:36px;background:linear-gradient(90deg,#f97316,#0ea5e9 ${i % 100}%,#22c55e)"></div></section>`).join('')}
<script>let hue=0;addEventListener('mousedown',()=>{hue=(hue+37)%360;document.getElementById('h').style.background='hsl('+hue+',70%,40%)'})</script>`
const app = RUN ? Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response(page, { headers: { 'content-type': 'text/html; charset=utf-8' } }) }) : null
afterAll(() => { app?.stop(true) })

/** The surfaces: the owner's panel, and 1280 / 390 wide at DPR 1 and 2. */
const SURFACES: Array<{ name: string; v: ViewerViewport }> = [
  { name: 'dono-1240x700@1.75', v: { width: 1240, height: 700, deviceScaleFactor: 1.75 } },
  { name: '1280x720@1', v: { width: 1280, height: 720, deviceScaleFactor: 1 } },
  { name: '1280x720@2', v: { width: 1280, height: 720, deviceScaleFactor: 2 } },
  { name: '390x646@1', v: { width: 388, height: 646, deviceScaleFactor: 1 } },
  { name: '390x646@2', v: { width: 388, height: 646, deviceScaleFactor: 2 } },
]

/** Sum of VmRSS over the browser process tree rooted at `pid` (KB -> MB). */
function treeRssMb(root: number): number {
  const kids = new Map<number, number[]>()
  for (const e of readdirSync('/proc')) {
    if (!/^\d+$/.test(e)) continue
    try {
      const st = readFileSync(`/proc/${e}/stat`, 'utf8')
      const ppid = Number(st.slice(st.lastIndexOf(')') + 2).split(' ')[1])
      kids.set(ppid, [...(kids.get(ppid) ?? []), Number(e)])
    } catch { /* gone */ }
  }
  let kb = 0
  const walk = (p: number) => {
    try { const m = /VmRSS:\s+(\d+)/.exec(readFileSync(`/proc/${p}/status`, 'utf8')); if (m) kb += Number(m[1]) } catch { /* gone */ }
    for (const c of kids.get(p) ?? []) walk(c)
  }
  walk(root)
  return Math.round(kb / 1024)
}

/** utime+stime ticks of the browser process tree and of this process (the server side: hub + CDP + base64). */
function cpuTicks(root: number): { browser: number; server: number } {
  const kids = new Map<number, number[]>()
  const ticks = new Map<number, number>()
  for (const e of readdirSync('/proc')) {
    if (!/^\d+$/.test(e)) continue
    try {
      const st = readFileSync(`/proc/${e}/stat`, 'utf8')
      const f = st.slice(st.lastIndexOf(')') + 2).split(' ')
      kids.set(Number(f[1]), [...(kids.get(Number(f[1])) ?? []), Number(e)])
      ticks.set(Number(e), Number(f[11]) + Number(f[12]))
    } catch { /* gone */ }
  }
  let browser = 0
  const walk = (p: number) => { browser += ticks.get(p) ?? 0; for (const c of kids.get(p) ?? []) walk(c) }
  walk(root)
  return { browser, server: ticks.get(process.pid) ?? 0 }
}

const median = (a: number[]) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)]! : NaN }

d('fluidez/nitidez probe with a real headless Chromium', () => {
  test('before vs after, every surface', async () => {
    mkdirSync(OUT, { recursive: true })
    const host = createBrowserHost({ dataDir, agentisticsPorts: [47291, 47292], memAvailable: async () => (await readMemory())?.available ?? null, log: () => {} })
    const owner = { kind: 'session', managedId: 'fluidez-1' } as const
    const r = await host.start(owner)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const rows: Array<Record<string, unknown>> = []
    try {
      const ah = host.actionHost(r.key)!
      await runAction(ah, { action: 'navigate', url: `http://127.0.0.1:${app!.port}/` } as any)
      const cdp = host.cdpOf(r.key)!
      const tab = ah.activeTab()!
      const sid = await ah.sessionFor(tab)
      // a second tab, the "client": decodes frames and measures sharpness at the surface's physical size
      const { targetId: judgeTarget } = await cdp.send('Target.createTarget', { url: 'about:blank' })
      const { sessionId: jsid } = await cdp.send('Target.attachToTarget', { targetId: judgeTarget, flatten: true })
      const evalJudge = async (expression: string) => (await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, jsid)).result?.value
      await cdp.send('Target.activateTarget', { targetId: tab })

      for (const mode of ((process.env.FLUIDEZ_MODES ?? 'before,after').split(',') as Array<'before' | 'after'>)) {
        for (const s of SURFACES.filter(x => !process.env.FLUIDEZ_SURFACES || process.env.FLUIDEZ_SURFACES.split(',').includes(x.name))) {
          const frames: Array<CastFrame & { recvAt: number }> = []
          const sharpLog: string[] = []
          const slow: string[] = []
          const hub = createScreencastHub({
            start: async (_k, _t, onFrame, size): Promise<StartCast> => {
              const off = host.onCdpEvent(r.key, ev => { if (ev.method === 'Page.screencastFrame' && ev.sessionId === sid) onFrame(ev.params) })
              const send = (m: string, p: Record<string, unknown>) => cdp.send(m, p, sid)
              if (mode === 'after') {
                const cast = createViewportCast(send)
                await cast.start(size)
                return { ok: true, ack: n => { void send('Page.screencastFrameAck', { sessionId: n }).catch(() => {}) }, viewport: () => cast.current(), sharp: async () => { const a = Date.now(); const v = await cast.sharp(); sharpLog.push(`${a % 100000}+${Date.now() - a}`); return v }, stop: async () => { off(); await cast.stop() } }
              }
              const v = clampViewport(size!)!
              await send('Emulation.setDeviceMetricsOverride', { ...v, mobile: false })
              await send('Page.startScreencast', { format: 'jpeg', quality: 60, maxWidth: v.width, maxHeight: v.height, everyNthFrame: 1 })
              return { ok: true, ack: n => { void send('Page.screencastFrameAck', { sessionId: n }).catch(() => {}) }, viewport: () => ({ w: v.width, h: v.height }), stop: async () => { off(); await send('Page.stopScreencast', {}); await send('Emulation.clearDeviceMetricsOverride', {}) } }
            },
            state: (_k, t) => ({ tab: t, activeTab: t, lock: 'none', url: '', title: '', loading: false, tabs: [{ id: t, title: '', active: true }], lastAction: null }),
            activeTab: () => tab,
            viewer: () => {},
            now: () => Date.now(),
            setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: t => clearTimeout(t as any),
            setInterval: (fn, ms) => setInterval(fn, ms), clearInterval: t => clearInterval(t as any),
          })
          const sub = await hub.subscribe(r.key, tab, { frame: f => { frames.push({ ...f, recvAt: Date.now() }); return true }, state: () => {}, gone: () => {} }, s.v)
          await cdp.send('Runtime.evaluate', { expression: 'scrollTo(0,0); scrollY', returnByValue: true }, sid)
          await sleep(1500)
          const page = clampViewport(s.v)!
          // 1. scroll: wheel every 50 ms for 3 s
          const scrollFrom = frames.length
          const t0 = Date.now()
          const cpu0 = cpuTicks(r.pid)
          let rssPeak = 0
          while (Date.now() - t0 < 3000) {
            const da = Date.now()
            await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: page.width / 2, y: page.height / 2, deltaX: 0, deltaY: 120 }, sid)
            if (Date.now() - da > 200) slow.push(`${da % 100000}+${Date.now() - da}`)
            rssPeak = Math.max(rssPeak, treeRssMb(r.pid))
            await sleep(50)
          }
          const endY = (await cdp.send('Runtime.evaluate', { expression: 'scrollY', returnByValue: true }, sid)).result?.value
          console.log('[fluidez-dbg] t0', t0 % 100000, 'sharps', sharpLog.join(' '), 'slowWheel', slow.join(' '), 'scrollY end', endY, 'frames', frames.length - scrollFrom)
          const cpu1 = cpuTicks(r.pid)
          const secs = (Date.now() - t0) / 1000
          const cpuBrowser = Math.round((cpu1.browser - cpu0.browser) / secs) // ticks/s = % of one core
          const cpuServer = Math.round((cpu1.server - cpu0.server) / secs)
          const scrolled = frames.slice(scrollFrom).filter(f => !f.sharp)
          const fps = scrolled.length / ((Date.now() - t0) / 1000)
          const bytes = scrolled.map(f => Math.round(f.jpeg.length * 3 / 4))
          // 2. latency: still page, a click repaints the header (ONE repaint, a new colour every time) -> the first
          // frame of the page after it. A sharp frame does not count (it may be a screenshot taken before the click).
          // A click with no such frame in 2 s is LOST and counted, never skipped: a dropped repaint is the worst latency.
          // The waits sweep the click across the sharp frame of the previous click (≈ +370 ms) and its echo window.
          const lat: number[] = []
          let lost = 0
          const phases: string[] = []
          const WAITS = [700, 380, 420, 480, 540, 620, 750, 1000]
          for (const wait of WAITS) {
            await sleep(wait)
            const n = frames.length
            const at = Date.now()
            await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 20, y: 15, button: 'left', clickCount: 1 }, sid)
            await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 20, y: 15, button: 'left', clickCount: 1 }, sid)
            const until = Date.now() + 2000
            const reply = () => frames.slice(n).find(f => !f.sharp)
            while (!reply() && Date.now() < until) await sleep(5)
            const f = reply()
            if (f) lat.push(f.recvAt - at)
            else lost++
            // where the click fell against the sharp frame of the previous click (a screenshot in flight delays it)
            // (`m+120` = 120 ms after a motion frame, i.e. a screenshot may be in flight; `S+50` = 50 ms after the sharp one)
            const prev = frames[n - 1]
            phases.push(`${prev ? `${prev.sharp ? 'S' : 'm'}+${at - prev.recvAt}` : '-'}:${f ? f.recvAt - at : 'LOST'}`)
          }
          // 3. still picture (after = the sharp frame, if one came), and a lossless reference at the physical size
          // the still page: one sharp frame, then nothing (no flicker, no screenshot loop) for 6 s
          await sleep(1000)
          const stillFrom = frames.length
          await sleep(6000)
          const stillFrames = frames.length - stillFrom
          const still = frames.at(-1)!
          const shownW = Math.round(page.width * Math.min(s.v.width / page.width, s.v.height / page.height) * s.v.deviceScaleFactor)
          const shownH = Math.round(shownW * page.height / page.width)
          await cdp.send('Emulation.setDeviceMetricsOverride', { ...page, deviceScaleFactor: s.v.deviceScaleFactor, mobile: false }, sid)
          await sleep(300)
          const ref = (await cdp.send('Page.captureScreenshot', { format: 'png' }, sid)).data as string
          const tag = `${mode}-${s.name}`
          writeFileSync(join(OUT, `${tag}.jpg`), Buffer.from(still.jpeg, 'base64'))
          const judged = await evalJudge(`(async () => {
            const load = async src => { const i = new Image(); i.src = src; const t = performance.now(); await i.decode(); return [i, performance.now() - t] }
            const [a, decodeMs] = await load('data:image/jpeg;base64,${still.jpeg}')
            const [b] = await load('data:image/png;base64,${ref}')
            const W = ${shownW}, H = ${shownH}
            const px = img => { const c = new OffscreenCanvas(W, H); const x = c.getContext('2d'); x.imageSmoothingQuality = 'high'; x.drawImage(img, 0, 0, W, H); return x.getImageData(0, 0, W, H).data }
            const A = px(a), B = px(b)
            let se = 0, n = 0
            for (let k = 0; k < A.length; k += 4) for (let ch = 0; ch < 3; ch++) { const e = A[k + ch] - B[k + ch]; se += e * e; n++ }
            const psnr = 10 * Math.log10(255 * 255 / (se / n))
            return { decodeMs: Math.round(decodeMs * 10) / 10, psnr: Math.round(psnr * 100) / 100, jpegW: a.naturalWidth, jpegH: a.naturalHeight }
          })()`)
          rows.push({
            mode, surface: s.name, shown: `${shownW}x${shownH}`, frame: `${judged.jpegW}x${judged.jpegH}`,
            fps: Math.round(fps * 10) / 10, kbPerFrame: Math.round(median(bytes) / 1024), kbPerSec: Math.round(bytes.reduce((x, y) => x + y, 0) / 1024 / 3),
            latencyMs: median(lat), latencyMax: lat.length ? Math.max(...lat) : NaN, clicks: WAITS.length, lostClicks: lost, clickPhases: phases.join(' '), decodeMs: judged.decodeMs, psnrDb: judged.psnr, stillSharp: still.sharp === true, framesWhileStill6s: stillFrames, rssPeakMb: rssPeak, cpuBrowserPct: cpuBrowser, cpuServerPct: cpuServer,
          })
          const tail = frames.slice(-6).map(f => { const j = jpegDims(f.jpeg); return `${f.seq}${f.sharp ? 'S' : ''}:${j?.w}x${j?.h}@${f.recvAt - frames.at(-1)!.recvAt}` })
          const motionDims = [...new Set(scrolled.map(f => { const j = jpegDims(f.jpeg); return `${j?.w}x${j?.h}` }))]
          console.log('[fluidez-dbg]', tag, 'motion', motionDims.join(','), 'tail', tail.join(' '), 'sharps', frames.filter(f => f.sharp).length)
          sub.close()
          await sleep(400)
          console.log('[fluidez]', JSON.stringify(rows.at(-1)))
        }
      }
      // every click must reach the screen, in every mode and on every surface
      expect(rows.map(x => `${x.mode}/${x.surface}: ${x.lostClicks} lost`)).toEqual(rows.map(x => `${x.mode}/${x.surface}: 0 lost`))
    } finally {
      writeFileSync(join(OUT, 'results.json'), JSON.stringify(rows, null, 2))
      await host.stop(r.key, 'requested')
    }
  }, 600_000)
})
