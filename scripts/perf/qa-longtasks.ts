/**
 * QA/dev (not shipped): from a .cpuprofile written by qa-profile.ts, find the contiguous busy stretches
 * longer than 100 ms (what the page reports as long tasks) and print, for each, the source functions
 * that dominate it (inclusive) — so "what is in the 250 ms tasks" is a list, not a guess.
 *   bun scripts/perf/qa-longtasks.ts <profile> [minMs=100]
 * Reuses the sourcemap reader by importing qa-profile's helpers is not possible (it runs on import), so
 * a stretch is labelled by minified name + position and resolved with the same maps.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const [file, MIN] = process.argv.slice(2)
if (!file) { console.error('usage'); process.exit(2) }
const minMs = Number(MIN ?? 100)
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
interface Seg { col: number; src: number; line: number; name: number }
interface M { sources: string[]; names: string[]; lines: Seg[][] }
function decode(mappings: string): Seg[][] {
  const lines: Seg[][] = []
  let src = 0, sl = 0, sc = 0, nm = 0
  for (const ls of mappings.split(';')) {
    const segs: Seg[] = []
    let col = 0
    for (const seg of ls.split(',')) {
      if (!seg) continue
      const v: number[] = []
      let shift = 0, val = 0
      for (const ch of seg) { const d = B64.indexOf(ch); val += (d & 31) << shift; if (d & 32) shift += 5; else { v.push(val & 1 ? -(val >> 1) : val >> 1); val = 0; shift = 0 } }
      col += v[0]!
      if (v.length >= 4) { src += v[1]!; sl += v[2]!; sc += v[3]!; if (v.length >= 5) nm += v[4]! }
      segs.push({ col, src, line: sl, name: v.length >= 5 ? nm : -1 })
    }
    lines.push(segs)
  }
  return lines
}
const dist = join(import.meta.dir, '..', '..', 'packages', 'web', 'dist')
const cache = new Map<string, M | null>()
function mapFor(url: string): M | null {
  const f = url.split('/').pop()!
  if (cache.has(f)) return cache.get(f)!
  let m: M | null = null
  try { const j = JSON.parse(readFileSync(join(dist, 'assets', f + '.map'), 'utf8')) as { sources: string[]; names: string[]; mappings: string }; m = { sources: j.sources, names: j.names, lines: decode(j.mappings) } } catch { /* */ }
  cache.set(f, m)
  return m
}
interface Node { id: number; callFrame: { functionName: string; url: string; lineNumber: number; columnNumber: number }; children?: number[] }
const profile = JSON.parse(readFileSync(file, 'utf8')) as { nodes: Node[]; samples: number[]; timeDeltas: number[] }
const byId = new Map(profile.nodes.map(n => [n.id, n]))
const parent = new Map<number, number>()
for (const n of profile.nodes) for (const c of n.children ?? []) parent.set(c, n.id)
const labelCache = new Map<number, string>()
function label(id: number): string {
  const hit = labelCache.get(id)
  if (hit) return hit
  const cf = byId.get(id)!.callFrame
  let out = `${cf.functionName || '(anon)'} ${cf.url.split('/').pop() ?? ''}:${cf.lineNumber + 1}`
  const m = cf.url ? mapFor(cf.url) : null
  const segs = m?.lines[cf.lineNumber]
  if (m && segs) {
    let best: Seg | null = null
    for (const s of segs) { if (s.col <= cf.columnNumber) best = s; else break }
    if (best) out = `${cf.functionName || (best.name >= 0 ? m.names[best.name] : '(anon)')} ${m.sources[best.src]!.replace(/^(\.\.\/)+/, '').replace(/^.*node_modules\/\.bun\//, 'nm/')}:${best.line + 1}`
  }
  labelCache.set(id, out)
  return out
}
const isIdle = (id: number) => byId.get(id)!.callFrame.functionName === '(idle)'
let t = 0
interface Run { start: number; end: number; incl: Map<string, number> }
const runs: Run[] = []
let cur: Run | null = null
profile.samples.forEach((id, i) => {
  const dt = (profile.timeDeltas[i] ?? 0) / 1000
  t += dt
  if (isIdle(id)) { if (cur) { cur.end = t - dt; runs.push(cur); cur = null }; return }
  if (!cur) cur = { start: t - dt, end: t, incl: new Map() }
  const seen = new Set<string>()
  for (let c: number | undefined = id; c !== undefined; c = parent.get(c)) { const k = label(c); if (!seen.has(k)) { seen.add(k); cur.incl.set(k, (cur.incl.get(k) ?? 0) + dt) } }
})
if (cur) { (cur as Run).end = t; runs.push(cur) }
const long = runs.filter(r => r.end - r.start >= minMs)
console.log(`${long.length} busy stretches >= ${minMs} ms of ${runs.length}; total in them ${long.reduce((a, r) => a + r.end - r.start, 0).toFixed(0)} ms`)
const agg = new Map<string, number>()
for (const r of long) for (const [k, v] of r.incl) agg.set(k, (agg.get(k) ?? 0) + v)
const SKIP = /react-dom|scheduler|^\(root\)|^\(program\)|nm\/react/
console.log('--- dominant (inclusive) across the long stretches, React internals hidden ---')
console.log([...agg.entries()].filter(([k]) => !SKIP.test(k)).sort((a, b) => b[1] - a[1]).slice(0, 40).map(([k, v]) => `${v.toFixed(0).padStart(7)} ms  ${k}`).join('\n'))
console.log('--- per stretch (top 4 non-React) ---')
for (const r of long.slice(0, 25)) {
  const top = [...r.incl.entries()].filter(([k]) => !SKIP.test(k)).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([k, v]) => `${v.toFixed(0)}ms ${k}`).join(' | ')
  console.log(`${(r.end - r.start).toFixed(0).padStart(5)} ms @${(r.start / 1000).toFixed(1)}s  ${top}`)
}
