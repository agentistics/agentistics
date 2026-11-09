/**
 * QA (not part of the product): keystroke + route latency in a real browser over a COPY of the real store.
 *   bun scripts/perf/qa-browser.ts <home> <chromium|webkit> <width> <height> [writers=4]
 */
import { appendFileSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { quantiles, startPerfServer } from './server-harness.ts'

const [home, engine, W, H, WR] = process.argv.slice(2)
if (!home || !engine) { console.error('usage'); process.exit(2) }
const width = Number(W ?? 1280), height = Number(H ?? 800), WRITERS = Number(WR ?? 4)
const pw = await import('playwright')
const launcher = engine === 'webkit' ? pw.webkit : pw.chromium

const files: { path: string; m: number; size: number }[] = []
const projects = join(home, '.claude', 'projects')
for (const d of readdirSync(projects)) { try { for (const f of readdirSync(join(projects, d))) if (f.endsWith('.jsonl')) { const p = join(projects, d, f); const st = statSync(p); files.push({ path: p, m: st.mtimeMs, size: st.size }) } } catch { /* */ } }
files.sort((a, b) => b.m - a.m)
const biggest = [...files].sort((a, b) => b.size - a.size)[0]!

const s = await startPerfServer(home, { env: { PATH: `${join(import.meta.dir, 'fake-bin')}:${process.env.PATH}`, AGENTISTICS_DIR: join(home, '.agentistics') } })
const web = s.base.replace(/:(\d+)$/, (_, p) => `:${Number(p) + 1}`)
const out: Record<string, unknown> = { engine, width, height, writers: WRITERS }
let writer: ReturnType<typeof setInterval> | null = null
const browser = await launcher.launch({ headless: true })
try {
  const cwd = join(home, '..', 'work', 'qa-browser'); mkdirSync(cwd, { recursive: true })
  await Bun.write(join(cwd, '.fake-seed'), biggest.path)
  const sp = await (await fetch(`${s.base}/api/fleet/new`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ harness: 'claude', cwd, force: true, label: 'qa-browser' }) })).json() as { id?: string }
  if (!sp.id) throw new Error('could not start the fake session')
  const ctx = await browser.newContext({ viewport: { width, height }, ...(width < 500 ? { isMobile: true, hasTouch: true } : {}) })
  const page = await ctx.newPage()
  const t0 = Date.now()
  await page.goto(`${web}/sessions/${sp.id}`, { waitUntil: 'domcontentloaded' })
  await page.getByText('Yes, preserve my history').first().click({ timeout: 20_000 }).catch(() => {})
  try { await page.waitForSelector('textarea:not([disabled])', { timeout: 120_000 }) } catch (err) {
    await page.screenshot({ path: join(home, '..', `qa-fail-${engine}-${width}.png`) }).catch(() => {})
    throw err
  }
  out.composerReadyMs = Date.now() - t0
  await page.waitForTimeout(8_000)

  let n = 0
  writer = setInterval(() => {
    for (const f of files.slice(0, WRITERS)) appendFileSync(f.path, JSON.stringify({ type: 'user', uuid: crypto.randomUUID(), parentUuid: null, timestamp: new Date().toISOString(), message: { role: 'user', content: `qa ${n++}` } }) + '\n')
  }, 1_000)
  await page.evaluate(() => {
    const w = window as unknown as Record<string, unknown>
    const k2f: number[] = [], blocked: number[] = [], gaps: number[] = [], longs: number[] = []
    w.__m = { k2f, blocked, gaps, longs }
    let pend: number | null = null
    addEventListener('keydown', () => { if (pend === null) { pend = performance.now(); requestAnimationFrame(() => { k2f.push(performance.now() - pend!); pend = null }) } }, { capture: true })
    let last = performance.now()
    const loop = () => { const now = performance.now(); gaps.push(now - last); last = now; requestAnimationFrame(loop) }
    requestAnimationFrame(loop)
    try { new PerformanceObserver(l => { for (const e of l.getEntries()) longs.push(e.duration) }).observe({ type: 'longtask', buffered: false }) } catch { /* unsupported */ }
    try { new PerformanceObserver(l => { for (const e of l.getEntries() as PerformanceEventTiming[]) if (/key|input/.test(e.name)) blocked.push(e.processingEnd - e.startTime) }).observe({ type: 'event', durationThreshold: 16, buffered: false } as PerformanceObserverInit) } catch { /* unsupported */ }
  })
  await page.locator('textarea:not([disabled])').first().focus()
  let typed = 0
  for (let i = 0; i < 20; i++) { const text = 'typing a normal sentence into the composer. '; await page.keyboard.type(text, { delay: 60 }); typed += text.length }
  await page.waitForTimeout(1_000)
  const m = await page.evaluate(() => (window as unknown as { __m: { k2f: number[]; blocked: number[]; gaps: number[]; longs: number[] } }).__m)
  const q = quantiles(m.k2f)
  out.chars = typed
  out.keyToFrame = { p50: q.p50, p95: q.p95, max: Math.round(Math.max(...m.k2f)), n: m.k2f.length, over50: m.k2f.filter(x => x > 50).length, over100: m.k2f.filter(x => x > 100).length }
  out.frameGaps = { max: Math.round(Math.max(...m.gaps)), over100: m.gaps.filter(x => x > 100).length, over250: m.gaps.filter(x => x > 250).length }
  out.longTasks = { n: m.longs.length, max: m.longs.length ? Math.round(Math.max(...m.longs)) : 0, over100: m.longs.filter(x => x > 100).length }
  out.eventTimingOver16 = { n: m.blocked.length, max: m.blocked.length ? Math.round(Math.max(...m.blocked)) : 0 }

  // idle: stop typing, measure the page's main-thread gaps for 20s with the writers still going
  await page.evaluate(() => { const w = window as unknown as { __m: { gaps: number[]; longs: number[] } }; w.__m.gaps.length = 0; w.__m.longs.length = 0 })
  await page.waitForTimeout(20_000)
  const idle = await page.evaluate(() => (window as unknown as { __m: { gaps: number[]; longs: number[] } }).__m)
  out.idle20s = { gapsOver100: idle.gaps.filter(x => x > 100).length, gapMax: Math.round(Math.max(...idle.gaps)), longTasks: idle.longs.length, longMax: idle.longs.length ? Math.round(Math.max(...idle.longs)) : 0 }

  const routes = ['/', '/costs', '/repositories', '/tasks', '/sessions', '/tools']
  const paints: Record<string, number> = {}
  for (const r of routes) {
    paints[r] = Math.round(await page.evaluate(async path => {
      const t0 = performance.now()
      history.pushState({}, '', path)
      dispatchEvent(new PopStateEvent('popstate'))
      await new Promise(res => requestAnimationFrame(() => requestAnimationFrame(res)))
      return performance.now() - t0
    }, r))
    await page.waitForTimeout(1_500)
  }
  out.routePaintMs = paints
} finally {
  if (writer) clearInterval(writer)
  await browser.close().catch(() => {})
  await s.stop()
}
console.log('RESULT ' + JSON.stringify(out))
process.exit(0)
