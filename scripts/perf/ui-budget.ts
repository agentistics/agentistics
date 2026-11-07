/**
 * scripts/perf/ui-budget.ts — the BROWSER half of the APP.LENTO budgets: typing in a live session's
 * composer while sessions write (so the server pushes data patches under the keystrokes), and route
 * changes. Runs a THROWAWAY server over a synthetic home with the web bundle embedded, a fake `claude`
 * in tmux, and headless Chromium (playwright). Exit 1 when a ceiling in `budgets.json` is exceeded.
 *
 *   bun run build && bun run packages/server/scripts/embed-dist.ts
 *   bun scripts/perf/synth-home.ts /tmp/perf-home --scale 0.1
 *   bunx playwright install chromium
 *   bun scripts/perf/ui-budget.ts /tmp/perf-home
 *
 * What it measures, and why these two:
 * - `keystrokeEventP95Ms`: how long the page holds the thread for each key event (Event Timing:
 *   input delay + handlers, `processingEnd - startTime`) while two transcripts are appended every
 *   second. The frame's own paint is printed beside it but not budgeted: on a CI runner's software
 *   renderer it is ~30-50 ms whatever the page does. The owner's report was
 *   "as digitações têm travado": the keystroke itself was one frame, the stall was a 300 ms data
 *   derivation landing under it.
 * - `routePaintMaxMs`: from a client-side route change to the second animation frame after it.
 */
import { appendFileSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { quantiles, startPerfServer } from './server-harness.ts'

const home = process.argv[2]
if (!home) { console.error('usage: ui-budget.ts <home>'); process.exit(2) }
const budgets = await Bun.file(join(import.meta.dir, 'budgets.json')).json() as Record<string, unknown>
const { embeddedDist } = await import('../../packages/server/server/embedded-dist.generated.ts') as { embeddedDist: Record<string, unknown> }
if (!embeddedDist['/index.html']) { console.error('ui-budget: the web bundle is not embedded — run `bun run build && bun run packages/server/scripts/embed-dist.ts` first'); process.exit(2) }
if (!Bun.which('tmux')) { console.error('ui-budget: tmux is required (the live composer is a fake claude in tmux)'); process.exit(2) }
const { chromium } = await import('playwright')

const files: { path: string; size: number }[] = []
const projects = join(home, '.claude', 'projects')
for (const d of readdirSync(projects)) for (const f of readdirSync(join(projects, d))) if (f.endsWith('.jsonl')) { const p = join(projects, d, f); files.push({ path: p, size: statSync(p).size }) }
files.sort((a, b) => a.size - b.size)
const biggest = files[files.length - 1]!

// A fresh store, past the first-run archive question (it blocks the whole app until answered).
rmSync(join(home, '.agentistics'), { recursive: true, force: true }); mkdirSync(join(home, '.agentistics'), { recursive: true })
writeFileSync(join(home, '.agentistics', 'preferences.json'), JSON.stringify({ archiveMode: 'consolidate', lang: 'en' }))
const s = await startPerfServer(home, { env: { PATH: `${join(import.meta.dir, 'fake-bin')}:${process.env.PATH}` } })
const web = s.base.replace(/:(\d+)$/, (_, p) => `:${Number(p) + 1}`)
const measured: Record<string, number | null> = { keystrokeEventP95Ms: null, routePaintMaxMs: null }
let writer: ReturnType<typeof setInterval> | null = null
const browser = await chromium.launch({ headless: true })
try {
  const cwd = join(home, '..', 'work', 'ui-budget'); mkdirSync(cwd, { recursive: true })
  await Bun.write(join(cwd, '.fake-seed'), biggest.path)
  const sp = await (await fetch(`${s.base}/api/fleet/new`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ harness: 'claude', cwd, force: true, label: 'ui-budget' }) })).json() as { id?: string }
  if (!sp.id) throw new Error('could not start the fake session')
  const page = await browser.newPage()
  await page.goto(`${web}/sessions/${sp.id}`, { waitUntil: 'domcontentloaded' })
  try { await page.waitForSelector('textarea:not([disabled])', { timeout: 90_000 }) } catch (err) {
    await page.screenshot({ path: join(home, '..', 'ui-budget-failure.png') }).catch(() => {})
    throw err
  }
  await page.waitForTimeout(5_000)

  // Two sessions writing every second: the server rebuilds and pushes data patches meanwhile.
  let n = 0
  const writers = process.env.UI_BUDGET_WRITERS === '0' ? [] : files.slice(0, 2).map(f => f.path)
  writer = setInterval(() => {
    for (const f of writers) appendFileSync(f, JSON.stringify({ type: 'user', uuid: crypto.randomUUID(), parentUuid: null, timestamp: new Date().toISOString(), message: { role: 'user', content: `ui-budget ${n++}` } }) + '\n')
  }, 1_000)
  await page.evaluate(() => {
    const w = window as unknown as { __keys: number[]; __blocked: number[] }
    w.__keys = []; w.__blocked = []
    new PerformanceObserver(l => {
      for (const e of l.getEntries() as PerformanceEventTiming[]) {
        if (!/key|input/.test(e.name)) continue
        w.__keys.push(e.duration)
        // Input delay + handlers: the part the PAGE holds the thread for, without the frame's paint.
        w.__blocked.push(e.processingEnd - e.startTime)
      }
    })
      .observe({ type: 'event', durationThreshold: 16, buffered: false } as PerformanceObserverInit)
  })
  // focus, not click: a first-run notice may cover the page, and the keys go to the focused field either way.
  await page.locator('textarea:not([disabled])').first().focus()
  let typed = 0
  for (let i = 0; i < 4; i++) { const text = 'typing a normal sentence into the composer. '; await page.keyboard.type(text, { delay: 60 }); typed += text.length }
  await page.waitForTimeout(1_000)
  // Only events over the observer's 16 ms floor are reported; the rest count as 0 blocked (they
  // were answered inside one frame). 5 events per character (keydown, beforeinput, input, keypress, keyup).
  const r = await page.evaluate(() => { const w = window as unknown as { __keys: number[]; __blocked: number[] }; return { keys: w.__keys, blocked: w.__blocked } })
  const expected = typed * 5
  const blocked = [...r.blocked, ...Array(Math.max(0, expected - r.blocked.length)).fill(0)]
  const whole = [...r.keys, ...Array(Math.max(0, expected - r.keys.length)).fill(16)]
  measured.keystrokeEventP95Ms = Math.round(quantiles(blocked).p95)
  console.log(`key events ~${expected}, over 16 ms: ${r.keys.length}; blocked p50 ${Math.round(quantiles(blocked).p50)} p95 ${Math.round(quantiles(blocked).p95)}; whole event (incl. the frame) p50 ${Math.round(quantiles(whole).p50)} p95 ${Math.round(quantiles(whole).p95)}`)

  const routes = ['/', '/costs', '/repositories', '/tasks', '/sessions', '/tools']
  const paints: number[] = []
  for (const r of routes) {
    paints.push(await page.evaluate(async path => {
      const t0 = performance.now()
      history.pushState({}, '', path)
      dispatchEvent(new PopStateEvent('popstate'))
      await new Promise(res => requestAnimationFrame(() => requestAnimationFrame(res)))
      return performance.now() - t0
    }, r))
    await page.waitForTimeout(1_000)
  }
  measured.routePaintMaxMs = Math.round(Math.max(...paints))
} finally {
  if (writer) clearInterval(writer)
  await browser.close().catch(() => {})
  await s.stop()
}

let failed = 0
const rows: string[] = []
for (const k of ['keystrokeEventP95Ms', 'routePaintMaxMs']) {
  const ceiling = budgets[k] as number
  const v = measured[k]
  const verdict = v === null ? 'MISSING' : v <= ceiling ? 'ok' : 'OVER'
  if (verdict !== 'ok') failed++
  rows.push(`${verdict.padEnd(7)} ${k.padEnd(24)} ${String(v ?? '—').padStart(7)}  ≤ ${ceiling}`)
}
console.log(rows.join('\n'))
if (failed) { console.error(`\n${failed} UI budget(s) exceeded or not measured.`); process.exit(1) }
console.log('\nAll UI budgets hold.')
