/**
 * PERF.1 step 1 — a rebuild after a transcript grew must cost only that transcript, and must answer
 * EXACTLY what a full build from scratch answers.
 *
 * The build keeps per-file state in module memory (harness readers, the parse cache, the consolidate
 * store), so each scenario runs in its own child process over a throwaway synthetic HOME (the same
 * generators `scripts/perf/` measures with — no byte from a real machine):
 *
 *  A. one process builds, rebuilds with nothing changed, then a Claude transcript and a Codex rollout
 *     grow and it rebuilds INCREMENTALLY;
 *  B. a fresh process builds the same tree from scratch.
 *
 * A's last answer must equal B's byte for byte; two unchanged rebuilds must be byte-identical; the
 * incremental rebuild must stay under the 300 ms budget; and in the server's watcher-driven mode a
 * read past the old 30 s TTL must not start a build.
 */
import { test, expect } from 'bun:test'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const REPO = join(import.meta.dir, '..', '..', '..')

const INCREMENTAL = `
import { appendFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
const out = process.argv[2]!
let builds = 0
const log = console.log
console.log = (...a: unknown[]) => { if (String(a[0]).startsWith('[data] built')) builds++; log(...a) }
const data = await import('./data')
const ser = async () => data.serializedData(await data.buildApiResponse())
const first = (d: string, test: (n: string) => boolean): string => {
  for (const n of readdirSync(d).sort()) { const p = join(d, n); if (statSync(p).isDirectory()) { const r = first(p, test); if (r) return r } else if (test(n)) return p }
  return ''
}
await data.buildApiResponse()
await data.rebuildNow()
const unchangedA = await ser()
await data.rebuildNow()
const unchangedB = await ser()
const home = process.env.HOME!
const claude = first(join(home, '.claude', 'projects'), n => n.endsWith('.jsonl'))
const codex = first(join(home, '.codex', 'sessions'), n => n.startsWith('rollout-'))
const incMs: number[] = []
for (let i = 0; i < 3; i++) {
  appendFileSync(claude, JSON.stringify({ type: 'user', sessionId: 'x', uuid: 'u' + i, timestamp: '2026-10-02T10:0' + i + ':00.000Z', message: { role: 'user', content: 'appended ' + i } }) + '\\n')
  appendFileSync(codex, JSON.stringify({ timestamp: '2026-10-02T10:0' + i + ':00.000Z', type: 'event_msg', payload: { type: 'user_message', message: 'appended ' + i } }) + '\\n')
  const t = performance.now()
  await data.rebuildNow()
  incMs.push(performance.now() - t)
}
const final = await ser()
// The server's watcher-driven mode: a read long past the old 30 s TTL starts no build.
data.useWatcherDrivenRefresh()
const realNow = Date.now
Date.now = () => realNow() + 60_000
const before = builds
await data.buildApiResponse()
await Bun.sleep(400)
const ttlBuilds = builds - before
Date.now = realNow
writeFileSync(out, JSON.stringify({ unchangedSame: unchangedA === unchangedB, changed: final !== unchangedB, incMs, ttlBuilds, final }))
process.exit(0)
`

const FULL = `
import { writeFileSync } from 'node:fs'
const data = await import('./data')
await data.buildApiResponse()
await data.rebuildNow()
writeFileSync(process.argv[2]!, data.serializedData(await data.buildApiResponse()))
process.exit(0)
`

function run(args: string[], env: Record<string, string>): void {
  const p = Bun.spawnSync(args, { env: { ...process.env, ...env }, cwd: import.meta.dir, stdout: 'pipe', stderr: 'pipe' })
  if (p.exitCode !== 0) throw new Error(`${args.join(' ')} exited ${p.exitCode}: ${p.stderr.toString().slice(-2000)}`)
}

test('an incremental rebuild answers byte-for-byte what a full build answers, inside 300 ms', () => {
  const home = mkdtempSync(join(tmpdir(), 'rebuild-incremental-'))
  const scripts = [join(import.meta.dir, `.rebuild-inc-${process.pid}.ts`), join(import.meta.dir, `.rebuild-full-${process.pid}.ts`)]
  try {
    run(['bun', join(REPO, 'scripts/perf/synth-home.ts'), home, '--projects', '120', '--sessions', '120000', '--scale', '0.01', '--big', '0'], {})
    run(['bun', join(REPO, 'scripts/perf/synth-harnesses.ts'), home, '--codex', '300', '--codex-kb', '12', '--gemini', '6', '--copilot', '6'], {})
    mkdirSync(join(home, '.agentistics'), { recursive: true })
    writeFileSync(join(home, '.agentistics', 'preferences.json'), JSON.stringify({ archiveMode: 'consolidate' }))
    writeFileSync(scripts[0]!, INCREMENTAL)
    writeFileSync(scripts[1]!, FULL)
    const env = { HOME: home, AGENTISTICS_DIR: join(home, '.agentistics'), AGENTISTICS_TELEMETRY: '0', AGENTISTICS_JOURNAL: '0' }

    const a = join(home, 'incremental.json'), b = join(home, 'full.json')
    run(['bun', scripts[0]!, a], env)
    run(['bun', scripts[1]!, b], env)
    const inc = JSON.parse(readFileSync(a, 'utf-8')) as { unchangedSame: boolean; changed: boolean; incMs: number[]; ttlBuilds: number; final: string }

    expect(inc.unchangedSame).toBe(true)
    expect(inc.ttlBuilds).toBe(0)
    // Byte for byte. Compared as strings so a failure says where, not just "not equal".
    const full = readFileSync(b, 'utf-8')
    if (inc.final !== full) {
      let i = 0
      while (i < full.length && inc.final[i] === full[i]) i++
      throw new Error(`incremental differs from full at byte ${i}:\n  inc:  ${inc.final.slice(Math.max(0, i - 120), i + 120)}\n  full: ${full.slice(Math.max(0, i - 120), i + 120)}`)
    }
    // The appended turns reached the answer (the per-file caches noticed the change).
    expect(inc.changed).toBe(true)
    // Best of three: one slow sample on a loaded machine is noise, three are not.
    console.log(`[rebuild-incremental] incremental rebuilds: ${inc.incMs.map(Math.round).join(", ")} ms`)
    expect(Math.min(...inc.incMs)).toBeLessThan(300)
  } finally {
    for (const s of scripts) rmSync(s, { force: true })
    rmSync(home, { recursive: true, force: true })
  }
}, 120_000)
