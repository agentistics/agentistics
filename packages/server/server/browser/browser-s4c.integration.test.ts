/**
 * NAVEGADOR S4c — `close` → `navigate` (a new browser under the SAME owner key, hence the same profile dir)
 * must give a WORKING browser every time. QA S4b saw the new one exit 0 about half a second later and be
 * recorded as `crashed`. Opt-in, real Chromium, one file per process:
 *
 *   BROWSER_INTEGRATION=1 agentop run --rm -- bun test packages/server/server/browser/browser-s4c.integration.test.ts
 */
import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readMemory } from '../sessions/memory-probe'
import { createBrowserHost } from './browser-host'
import { runAction } from './browser-actions'

const RUN = process.env.BROWSER_INTEGRATION === '1'
const d = RUN ? describe : describe.skip
const CYCLES = Number(process.env.S4C_CYCLES ?? 12)
const logs: string[] = []
const t0 = Date.now()
const log = (...a: unknown[]) => { const s = `+${Date.now() - t0}ms ` + a.join(' '); logs.push(s); console.log('[s4c]', s) }
const dataDir = mkdtempSync(join(tmpdir(), 'browser-s4c-'))
afterAll(() => { rmSync(dataDir, { recursive: true, force: true }) })
const page = `<!doctype html><title>qa</title><body style="margin:0"><div id=d style="position:fixed;inset:0"></div><script>let n=0;function f(){n++;document.getElementById('d').style.background='hsl('+(n*7%360)+',80%,50%)';requestAnimationFrame(f)};f()</script>`
const app = RUN ? Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response(page, { headers: { 'content-type': 'text/html' } }) }) : null
afterAll(() => { app?.stop(true) })
const realKill = process.kill.bind(process)
if (process.env.S4C_KILLLOG === '1') (process as any).kill = (pid: number, sig?: any) => { if (sig !== 0) log('KILL', pid, sig); return realKill(pid, sig) }
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

d('close → navigate with a real headless Chromium', () => {
  test(`${CYCLES} cycles: every new browser is still live (and answers) 2 s after it started`, async () => {
    const host = createBrowserHost({ dataDir, agentisticsPorts: [47291, 47292], memAvailable: async () => (await readMemory())?.available ?? null, log })
    const owner = { kind: 'session', managedId: 's4c-1' } as const
    const stops: string[] = []
    host.onStopped((_k, reason) => stops.push(reason))
    try {
      for (let i = 1; i <= CYCLES; i++) {
        const r = await host.start(owner)
        expect(r.ok).toBe(true)
        if (!r.ok) return
        await sleep(Number(process.env.S4C_SETTLE ?? 1200))
        const h = host.actionHost(r.key)
        expect({ cycle: i, live: h !== null, stops: [...stops] }).toEqual({ cycle: i, live: true, stops: stops.filter(s => s === 'requested') })
        if (process.env.S4C_BUSY !== '0') {
          // as the QA loop did: an animated page being screencast when the browser is closed
          const ah = host.actionHost(r.key)!
          await runAction(ah, { action: 'navigate', url: `http://127.0.0.1:${app!.port}/` } as any)
          const cdp = host.cdpOf(r.key)!
          const sid = await ah.sessionFor(ah.activeTab()!)
          await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 60, everyNthFrame: 1 }, sid)
          const off = host.onCdpEvent(r.key, (ev) => { if (ev.method === 'Page.screencastFrame') void cdp.send('Page.screencastFrameAck', { sessionId: (ev.params as any).sessionId }, sid).catch(() => {}) })
          await sleep(500)
          off()
        }
        await host.stop(r.key, 'requested')
      }
    } finally {
      await host.stop('s-s4c-1', 'requested')
    }
  }, 240_000)
})
