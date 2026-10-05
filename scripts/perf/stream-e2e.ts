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
// The vite binary itself, not `bunx vite`: killing the `bunx` wrapper left its node child serving.
const vite = spawn([join(REPO, 'packages/web/node_modules/.bin/vite'), '--port', String(webPort), '--strictPort'], {
  cwd: join(REPO, 'packages/web'), env: { ...process.env, PORT: String(apiPort), WEB_PORT: String(webPort) }, stdout: 'ignore', stderr: 'ignore',
})
const browser = await chromium.launch(process.env.PLAYWRIGHT_CHROMIUM ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM } : {})
let failed = false
// The harness's own heartbeat (see the retry rule below) and the page's requests in flight, so a stalled
// round says what the page was waiting on (the browser holds six connections per origin).
const PAUSE_MS = 1000
const pauses: number[] = []
let beat = Date.now()
const heartbeat = setInterval(() => { const n = Date.now(); if (n - beat > 250) pauses.push(n - beat); beat = n }, 50)
const open = new Map<string, { url: string; at: number; got: boolean }>()
const inflight: string[] = []
let watchNet: ReturnType<typeof setInterval> | undefined
const report: { round: number; timeline: { t: number; live: number; done: number }[]; growthSteps: number; firstLiveMs: number | null; doneMs: number | null; doubled: number; gap: number }[] = []
try {
  const post = (path: string, body: unknown) => fetch(`${s.base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  await fetch(`${s.base}/api/preferences`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ archiveMode: 'off' }) })
  const cwd = join(home, '..', 'work', 'stream-e2e'); mkdirSync(cwd, { recursive: true })
  const sp = await (await post('/api/fleet/new', { harness: 'claude', cwd, force: true, label: 'stream-e2e' })).json() as { ok: boolean; id?: string; message?: string }
  if (!sp.ok || !sp.id) throw new Error(`spawn failed: ${sp.message}`)
  const id = sp.id
  for (let i = 0; i < 120; i++) { try { if ((await fetch(`http://localhost:${webPort}/`)).ok) break } catch { /* not yet */ } await Bun.sleep(500) }
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Network.enable')
  const short = (u: string) => u.replace(/^https?:\/\/[^/]+/, '').split('?')[0]!.slice(0, 50)
  cdp.on('Network.requestWillBeSent', (e: { requestId: string; request: { url: string } }) => { open.set(e.requestId, { url: short(e.request.url), at: Date.now(), got: false }) })
  cdp.on('Network.responseReceived', (e: { requestId: string }) => { const o = open.get(e.requestId); if (o) o.got = true })
  for (const ev of ['Network.loadingFinished', 'Network.loadingFailed']) cdp.on(ev, (e: { requestId: string }) => { open.delete(e.requestId) })
  watchNet = setInterval(() => { inflight.push(`${new Date().toISOString().slice(17, 23)} ${[...open.values()].filter(o => o.url.startsWith('/api')).map(o => o.url + (o.got ? '' : ' (waiting)')).join(', ')}`); if (inflight.length > 40) inflight.shift() }, 1000)
  await page.goto(`http://localhost:${webPort}/sessions/${id}`)
  // The chat is up once its composer is (the dev server's first load optimises deps — slow).
  await page.waitForSelector('textarea', { timeout: 120_000, state: 'attached' })
    .catch(async (e) => { await page.screenshot({ path: join(home, '..', 'stream-e2e-fail.png') }); throw e })
  await Bun.sleep(3000)

  for (let round = 0; round < ROUNDS; round++) {
  for (let attempt = 0; ; attempt++) {
    const marker = `streame2e${round}x${Date.now()}`
    const t0 = Date.now()
    pauses.length = 0
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
    // The answer must never be on NO screen: once it has been seen live, every sample until the
    // finished turn is there shows one of the two. (The live bubble is held until the turn lands.)
    const firstLiveAt = timeline.findIndex(x => x.live > 0)
    const gap = firstLiveAt < 0 ? 0 : timeline.slice(firstLiveAt).filter(x => x.live === 0 && x.done === 0).length
    report.push({ round, timeline: changes, growthSteps: steps, firstLiveMs, doneMs: doneAt, doubled, gap })
    log(`round ${round}: grew ${steps}x, first live ${firstLiveMs} ms, finished turn ${doneAt} ms, drawn twice in ${doubled} samples, empty gap in ${gap} samples`)
    const bad = steps < MIN_GROWTH_STEPS || doneAt === null || doubled > 0 || gap > 0
    // A round during which THIS PROCESS's own timer stalled for over a second measured the machine
    // pausing, not the page: a plain timer outside the product stopped for 3.6 s about every 36 s on a
    // WSL box with the product idle. Such a round is measured again (twice at most) and says so; a
    // round that fails with the harness running normally still fails.
    const paused = Math.max(0, ...pauses)
    if (bad && paused >= PAUSE_MS && attempt < 2) { log(`round ${round}: the harness itself paused ${paused} ms — measuring it again (${attempt + 1}/2)`); report.pop(); await Bun.sleep(1500); continue }
    if (bad) { failed = true; log(`round ${round}: in flight at the page during the round:\n${inflight.slice(-12).join('\n')}`) }
    await Bun.sleep(1500)
    break
  }
  }
  await post('/api/fleet/act', { id, action: 'kill' }).catch(() => {})
} finally {
  clearInterval(heartbeat); clearInterval(watchNet)
  await browser.close()
  vite.kill()
  await s.stop()
}
const json = JSON.stringify(report, null, 2)
console.log(json)
if (jsonOut) await Bun.write(jsonOut, json)
if (failed) { console.error(`\nThe chat page did not show the answer growing (≥ ${MIN_GROWTH_STEPS} steps before the finished turn, never drawn twice) in every round.`); process.exit(1) }
console.log('\nThe chat page streams the answer as it is written.')
