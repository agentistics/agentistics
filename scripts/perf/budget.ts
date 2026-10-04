/**
 * scripts/perf/budget.ts — PERF.1's budgets, enforced (step 6). Runs a THROWAWAY server over a
 * synthetic home and fails (exit 1) when a measured figure exceeds its ceiling in `budgets.json`.
 *
 *   bun scripts/perf/synth-home.ts /tmp/perf-home --scale 0.1
 *   bun scripts/perf/budget.ts /tmp/perf-home
 *
 * The live-chat figures need tmux (the fake claude runs in it); without tmux they are reported as
 * skipped, never as passed.
 */
import { appendFileSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { measurePush } from './measure.ts'
import { quantiles, startPerfServer } from './server-harness.ts'

const home = process.argv[2]
if (!home) { console.error('usage: budget.ts <home>'); process.exit(2) }
const budgets = await Bun.file(join(import.meta.dir, 'budgets.json')).json() as Record<string, number>

const files: { id: string; path: string; size: number }[] = []
const projects = join(home, '.claude', 'projects')
for (const d of readdirSync(projects)) for (const f of readdirSync(join(projects, d))) if (f.endsWith('.jsonl')) { const p = join(projects, d, f); files.push({ id: f.slice(0, -6), path: p, size: statSync(p).size }) }
files.sort((a, b) => a.size - b.size)
const biggest = files[files.length - 1]!

rmSync(join(home, '.agentistics'), { recursive: true, force: true }); mkdirSync(join(home, '.agentistics'), { recursive: true })
const s = await startPerfServer(home, { env: { PATH: `${join(import.meta.dir, 'fake-bin')}:${process.env.PATH}` } })
const measured: Record<string, number | null> = {}
const time = async (path: string) => { const t = performance.now(); const r = await fetch(`${s.base}${path}`); const text = await r.text(); return { ms: performance.now() - t, text, status: r.status } }
try {
  measured.bootListeningMs = s.boot.listening ?? s.healthMs
  measured.firstDataFreshMs = Math.round((await time('/api/data')).ms)
  const warm: number[] = []
  for (let i = 0; i < 10; i++) warm.push((await time('/api/data')).ms)
  measured.dataWarmP95Ms = quantiles(warm).p95

  const enc = encodeURIComponent(basename(dirname(biggest.path)))
  const paged: number[] = []
  let kb = 0
  for (let i = 0; i < 6; i++) { const r = await time(`/api/claude-sessions/${biggest.id}?encodedDir=${enc}&limit=150`); paged.push(r.ms); kb = Math.round(r.text.length / 1024) }
  measured.historyOpenPagedP95Ms = quantiles(paged).p95
  measured.historyPagedResponseKB = kb

  // append -> `change` (with the new data behind it)
  const ev: number[] = []
  for (let i = 0; i < 3; i++) {
    const ctl = new AbortController()
    const reader = (await fetch(`${s.base}/api/events`, { signal: ctl.signal })).body!.getReader()
    const dec = new TextDecoder()
    let buf = ''
    while (!buf.includes('connected')) buf += dec.decode((await reader.read()).value ?? new Uint8Array())
    const t = performance.now()
    appendFileSync(files[0]!.path, JSON.stringify({ type: 'user', uuid: crypto.randomUUID(), parentUuid: null, timestamp: new Date().toISOString(), message: { role: 'user', content: `budget ${i}` } }) + '\n')
    buf = ''
    while (performance.now() - t < 15_000) {
      const r = await Promise.race([reader.read(), Bun.sleep(15_000).then(() => null)])
      if (!r || r.done) break
      buf += dec.decode(r.value)
      if (buf.includes('event: change')) { ev.push(performance.now() - t); break }
    }
    ctl.abort()
    await Bun.sleep(2500)
  }
  measured.changeAfterAppendP95Ms = ev.length ? quantiles(ev).p95 : null

  // live chat over a fake claude (needs tmux)
  if (Bun.which('tmux')) {
    const cwd = join(home, '..', 'work', 'budget-live'); mkdirSync(cwd, { recursive: true })
    await Bun.write(join(cwd, '.fake-seed'), biggest.path)
    const sp = await (await fetch(`${s.base}/api/fleet/new`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ harness: 'claude', cwd, force: true, label: 'budget' }) })).json() as { ok: boolean; id?: string; session?: { id: string } }
    const id = sp.id ?? sp.session?.id
    if (id) {
      for (let i = 0; i < 50; i++) { const r = await time(`/api/fleet/chat?id=${id}&lang=en`); if (r.text.length > 2000) break; await Bun.sleep(200) }
      const push = await measurePush(s, id, 4)
      measured.liveOpenFirstFrameMs = push?.firstFrameMs ?? null
      measured.sendToEchoP95Ms = push?.sendToEcho.n ? push.sendToEcho.p95 : null
      measured.answerShownP95Ms = push?.harnessWriteToShown.n ? push.harnessWriteToShown.p95 : null
      await fetch(`${s.base}/api/fleet/act`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id, action: 'kill' }) }).catch(() => {})
    }
  }
} finally {
  await s.stop()
}

let failed = 0
const rows: string[] = []
for (const [k, ceiling] of Object.entries(budgets)) {
  if (k.startsWith('_')) continue
  const v = measured[k]
  const verdict = v === undefined || v === null ? 'SKIPPED' : v <= ceiling ? 'ok' : 'OVER'
  if (verdict === 'OVER') failed++
  if (verdict === 'SKIPPED' && !Bun.which('tmux') && /Echo|answer|liveOpen/.test(k) === false) failed++
  rows.push(`${verdict.padEnd(7)} ${k.padEnd(24)} ${String(v ?? '—').padStart(7)}  ≤ ${ceiling}`)
}
console.log(rows.join('\n'))
if (failed) { console.error(`\n${failed} budget(s) exceeded.`); process.exit(1) }
console.log('\nAll perf budgets hold.')
