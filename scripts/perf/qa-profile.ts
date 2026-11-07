/**
 * QA/dev (not shipped): CPU profile of the page WHILE TYPING, mapped back to source through the build's
 * sourcemaps. Chromium only (CDP). Same scenario as qa-browser.ts: a live fake-claude composer, transcripts
 * appended every second, 20 sentences typed at 60 ms.
 *   bunx vite build --sourcemap   (in packages/web, then embed-dist)
 *   bun scripts/perf/qa-profile.ts <home> [width=1280] [height=800] [writers=4]
 * Prints the heaviest functions by self time and by inclusive time, and the page's long-task count.
 */
import { appendFileSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { startPerfServer } from './server-harness.ts'

const [home, W, H, WR] = process.argv.slice(2)
if (!home) { console.error('usage'); process.exit(2) }
const width = Number(W ?? 1280), height = Number(H ?? 800), WRITERS = Number(WR ?? 4)
const pw = await import('playwright')

// ── a tiny sourcemap reader (VLQ) ────────────────────────────────────────────────────────────
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
interface Seg { col: number; src: number; line: number; scol: number; name: number }
interface Map1 { sources: string[]; names: string[]; lines: Seg[][] }
function decode(mappings: string): Seg[][] {
  const lines: Seg[][] = []
  let src = 0, sl = 0, sc = 0, nm = 0
  for (const lineStr of mappings.split(';')) {
    const segs: Seg[] = []
    let col = 0
    for (const seg of lineStr.split(',')) {
      if (!seg) continue
      const v: number[] = []
      let shift = 0, val = 0
      for (const ch of seg) {
        const d = B64.indexOf(ch)
        val += (d & 31) << shift
        if (d & 32) { shift += 5 } else { v.push(val & 1 ? -(val >> 1) : val >> 1); val = 0; shift = 0 }
      }
      col += v[0]!
      if (v.length >= 4) { src += v[1]!; sl += v[2]!; sc += v[3]!; if (v.length >= 5) nm += v[4]! }
      segs.push({ col, src, line: sl, scol: sc, name: v.length >= 5 ? nm : -1 })
    }
    lines.push(segs)
  }
  return lines
}
const maps = new Map<string, Map1>()
const dist = join(import.meta.dir, '..', '..', 'packages', 'web', 'dist')
function mapFor(url: string): Map1 | null {
  const file = url.split('/').pop()!
  if (maps.has(file)) return maps.get(file)!
  let m: Map1 | null = null
  try { const j = JSON.parse(readFileSync(join(dist, 'assets', file + '.map'), 'utf8')) as { sources: string[]; names: string[]; mappings: string }; m = { sources: j.sources, names: j.names, lines: decode(j.mappings) } } catch { /* no map */ }
  maps.set(file, m)
  return m
}
function original(url: string, line: number, col: number): { file: string; line: number; name: string | null } | null {
  const m = mapFor(url)
  if (!m) return null
  const segs = m.lines[line]
  if (!segs) return null
  let best: Seg | null = null
  for (const s of segs) { if (s.col <= col) best = s; else break }
  if (!best) return null
  return { file: m.sources[best.src]!.replace(/^(\.\.\/)+/, ''), line: best.line + 1, name: best.name >= 0 ? m.names[best.name]! : null }
}

const files: { path: string; m: number; size: number }[] = []
const projects = join(home, '.claude', 'projects')
for (const d of readdirSync(projects)) { try { for (const f of readdirSync(join(projects, d))) if (f.endsWith('.jsonl')) { const p = join(projects, d, f); const st = statSync(p); files.push({ path: p, m: st.mtimeMs, size: st.size }) } } catch { /* */ } }
files.sort((a, b) => b.m - a.m)
const biggest = [...files].sort((a, b) => b.size - a.size)[0]!

const s = await startPerfServer(home, { env: { PATH: `${join(import.meta.dir, 'fake-bin')}:${process.env.PATH}`, AGENTISTICS_DIR: join(home, '.agentistics') } })
const web = s.base.replace(/:(\d+)$/, (_, p) => `:${Number(p) + 1}`)
let writer: ReturnType<typeof setInterval> | null = null
const browser = await pw.chromium.launch({ headless: true })
try {
  const cwd = join(home, '..', 'work', 'qa-browser'); mkdirSync(cwd, { recursive: true })
  await Bun.write(join(cwd, '.fake-seed'), biggest.path)
  const sp = await (await fetch(`${s.base}/api/fleet/new`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ harness: 'claude', cwd, force: true, label: 'qa-browser' }) })).json() as { id?: string }
  if (!sp.id) throw new Error('could not start the fake session')
  const ctx = await browser.newContext({ viewport: { width, height } })
  const page = await ctx.newPage()
  await page.goto(`${web}/sessions/${sp.id}`, { waitUntil: 'domcontentloaded' })
  await page.getByText('Yes, preserve my history').first().click({ timeout: 20_000 }).catch(() => {})
  await page.waitForSelector('textarea:not([disabled])', { timeout: 120_000 })
  await page.waitForTimeout(8_000)
  let n = 0
  writer = setInterval(() => { for (const f of files.slice(0, WRITERS)) appendFileSync(f.path, JSON.stringify({ type: 'user', uuid: crypto.randomUUID(), parentUuid: null, timestamp: new Date().toISOString(), message: { role: 'user', content: `qa ${n++}` } }) + '\n') }, 1_000)
  await page.evaluate(() => {
    const w = window as unknown as Record<string, unknown>
    const longs: number[] = []
    w.__longs = longs
    try { new PerformanceObserver(l => { for (const e of l.getEntries()) longs.push(e.duration) }).observe({ type: 'longtask', buffered: false }) } catch { /* */ }
  })
  await page.locator('textarea:not([disabled])').first().focus()
  const cdp = await ctx.newCDPSession(page)
  await cdp.send('Profiler.enable')
  await cdp.send('Profiler.setSamplingInterval', { interval: 500 })
  await cdp.send('Profiler.start')
  for (let i = 0; i < 20; i++) await page.keyboard.type('typing a normal sentence into the composer. ', { delay: 60 })
  const { profile } = await cdp.send('Profiler.stop') as { profile: { nodes: { id: number; callFrame: { functionName: string; url: string; lineNumber: number; columnNumber: number }; children?: number[] }[]; samples: number[]; timeDeltas: number[] } }
  const longs = await page.evaluate(() => (window as unknown as { __longs: number[] }).__longs)
  writeFileSync(join(home, '..', 'last.cpuprofile'), JSON.stringify(profile))

  const byId = new Map(profile.nodes.map(nd => [nd.id, nd]))
  const parent = new Map<number, number>()
  for (const nd of profile.nodes) for (const c of nd.children ?? []) parent.set(c, nd.id)
  const label = (id: number): string => {
    const cf = byId.get(id)!.callFrame
    const o = cf.url ? original(cf.url, cf.lineNumber, cf.columnNumber) : null
    const fn = cf.functionName || (o?.name ?? '(anon)')
    return o ? `${fn} ${o.file}:${o.line}` : `${fn} ${cf.url.split('/').pop() ?? ''}:${cf.lineNumber + 1}`
  }
  const self = new Map<string, number>(), incl = new Map<string, number>()
  let total = 0, idle = 0
  profile.samples.forEach((id, i) => {
    const dt = (profile.timeDeltas[i] ?? 0) / 1000
    const l = label(id)
    if (/^\((idle)\)/.test(l)) { idle += dt; return }
    total += dt
    self.set(l, (self.get(l) ?? 0) + dt)
    const seen = new Set<string>()
    for (let cur: number | undefined = id; cur !== undefined; cur = parent.get(cur)) { const k = label(cur); if (!seen.has(k)) { seen.add(k); incl.set(k, (incl.get(k) ?? 0) + dt) } }
  })
  const top = (m: Map<string, number>, k: number) => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, k).map(([l, ms]) => `${ms.toFixed(0).padStart(7)} ms  ${l}`).join('\n')
  console.log(`busy ${total.toFixed(0)} ms, idle ${idle.toFixed(0)} ms over ${(profile.timeDeltas.reduce((a, b) => a + b, 0) / 1000).toFixed(0)} ms; long tasks ${longs.length} (>100: ${longs.filter(x => x > 100).length}, max ${longs.length ? Math.round(Math.max(...longs)) : 0})`)
  console.log('--- SELF ---\n' + top(self, 25))
  console.log('--- INCLUSIVE ---\n' + top(incl, 45))
} finally {
  if (writer) clearInterval(writer)
  await browser.close().catch(() => {})
  await s.stop()
}
process.exit(0)
