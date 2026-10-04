/**
 * scripts/perf/stream-e2e.ts — STREAM.FIX's page-level check: does the CHAT PAGE show a CLI answer
 * GROWING while it is written, or does it land whole?
 *
 *   bun scripts/perf/synth-home.ts /tmp/stream-home --scale 0.02 --big 0
 *   bun scripts/perf/stream-e2e.ts /tmp/stream-home [--json out.json]
 *
 * Owner report on v2.103.1: "o stream da conversa do Claude não está funcionando, vem tudo de uma
 * vez". Every server-side budget held at the time — the terminal frames DID reach the stream at
 * 150 ms — because the page never drew them. So this measures the only thing that matters: the
 * text on the page, sampled every 100 ms, over a THROWAWAY server (free ports, isolated tmux, a
 * synthetic home) and the fake `claude` that prints its answer word by word.
 *
 * Fails (exit 1) unless, in every round, the live answer on the page grew at least
 * `MIN_GROWTH_STEPS` times BEFORE the finished turn replaced it. Browser: Playwright's chromium;
 * `PLAYWRIGHT_CHROMIUM=<path>` points it at an existing one.
 */
import { chromium } from 'playwright'
import { spawn } from 'bun'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { startPerfServer } from './server-harness.ts'

const args = process.argv.slice(2)
const home = args[0]
if (!home) { console.error('usage: stream-e2e.ts <home> [--json out]'); process.exit(2) }
const jsonOut = (() => { const i = args.indexOf('--json'); return i >= 0 ? args[i + 1] : undefined })()
const ROUNDS = 3
const MIN_GROWTH_STEPS = 3
const REPO = join(import.meta.dir, '..', '..')
const log = (...a: unknown[]) => console.error('[stream-e2e]', ...a)

const s = await startPerfServer(home, { env: { PATH: `${join(import.meta.dir, 'fake-bin')}:${process.env.PATH}`, FAKE_STREAM_MS: '2000' } })
const apiPort = Number(new URL(s.base).port)
// The server itself binds port+1 (WEB_PORT); the dev UI goes beside it.
const webPort = apiPort + 3
const vite = spawn(['bunx', 'vite', '--port', String(webPort), '--strictPort'], {
  cwd: join(REPO, 'packages/web'), env: { ...process.env, PORT: String(apiPort), WEB_PORT: String(webPort) }, stdout: 'ignore', stderr: 'ignore',
})
const browser = await chromium.launch(process.env.PLAYWRIGHT_CHROMIUM ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM } : {})
let failed = false
const report: { round: number; timeline: { t: number; live: number; done: number }[]; growthSteps: number; firstLiveMs: number | null; doneMs: number | null; doubled: number }[] = []
try {
  const post = (path: string, body: unknown) => fetch(`${s.base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  await fetch(`${s.base}/api/preferences`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ archiveMode: 'off' }) })
  const cwd = join(home, '..', 'work', 'stream-e2e'); mkdirSync(cwd, { recursive: true })
  const sp = await (await post('/api/fleet/new', { harness: 'claude', cwd, force: true, label: 'stream-e2e' })).json() as { ok: boolean; id?: string; message?: string }
  if (!sp.ok || !sp.id) throw new Error(`spawn failed: ${sp.message}`)
  const id = sp.id
  for (let i = 0; i < 120; i++) { try { if ((await fetch(`http://localhost:${webPort}/`)).ok) break } catch { /* not yet */ } await Bun.sleep(500) }
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
  await page.goto(`http://localhost:${webPort}/sessions/${id}`)
  // The chat is up once its composer is (the dev server's first load optimises deps — slow).
  await page.waitForSelector('textarea', { timeout: 120_000, state: 'attached' })
    .catch(async (e) => { await page.screenshot({ path: join(home, '..', 'stream-e2e-fail.png') }); throw e })
  await Bun.sleep(3000)

  for (let round = 0; round < ROUNDS; round++) {
    const marker = `streame2e${round}x${Date.now()}`
    const t0 = Date.now()
    await post('/api/fleet/act', { id, action: 'prompt', text: marker })
    const timeline: { t: number; live: number; done: number }[] = []
    for (let i = 0; i < 80; i++) {
      const [live, done] = await page.evaluate((m) => {
        const words = (txt: string) => { const k = txt.lastIndexOf(`answer to ${m}`); return k < 0 ? 0 : txt.slice(k).split(/writtenAt=/)[0]!.split(/\s+/).filter(Boolean).length }
        const el = document.querySelector('[data-live-answer]') as HTMLElement | null
        const liveWords = el ? words(el.innerText.replace(/\s+/g, ' ')) : 0
        // The finished turn carries the harness's `writtenAt=` stamp; the screen never shows it.
        const body = document.body.innerText.replace(/\s+/g, ' ')
        const doneWords = new RegExp(`answer to ${m}[^]*?writtenAt=`).test(body) ? words(body) : 0
        return [liveWords, doneWords]
      }, marker)
      timeline.push({ t: Date.now() - t0, live, done })
      if (done > 0 && timeline.filter(x => x.done > 0).length > 3) break
      await Bun.sleep(100)
    }
    const doneAt = timeline.find(x => x.done > 0)?.t ?? null
    let steps = 0, longest = 0
    for (const x of timeline) { if (doneAt !== null && x.t >= doneAt) break; if (x.live > longest) { longest = x.live; steps++ } }
    const firstLiveMs = timeline.find(x => x.live > 0)?.t ?? null
    const changes = timeline.filter((x, i) => i === 0 || x.live !== timeline[i - 1]!.live || x.done !== timeline[i - 1]!.done)
    // The same answer drawn twice — live AND finished — is the defect the live bubble was once
    // removed for; once the finished turn is on the page the live one must be gone.
    const doubled = timeline.filter(x => x.live > 0 && x.done > 0).length
    report.push({ round, timeline: changes, growthSteps: steps, firstLiveMs, doneMs: doneAt, doubled })
    log(`round ${round}: grew ${steps}x, first live ${firstLiveMs} ms, finished turn ${doneAt} ms, drawn twice in ${doubled} samples`)
    if (steps < MIN_GROWTH_STEPS || doneAt === null || doubled > 0) failed = true
    await Bun.sleep(1500)
  }
  await post('/api/fleet/act', { id, action: 'kill' }).catch(() => {})
} finally {
  await browser.close()
  vite.kill()
  await s.stop()
}
const json = JSON.stringify(report, null, 2)
console.log(json)
if (jsonOut) await Bun.write(jsonOut, json)
if (failed) { console.error(`\nThe chat page did not show the answer growing (≥ ${MIN_GROWTH_STEPS} steps before the finished turn, never drawn twice) in every round.`); process.exit(1) }
console.log('\nThe chat page streams the answer as it is written.')
