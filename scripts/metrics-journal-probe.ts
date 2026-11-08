/** Read-only inputs, copied under a throwaway directory. No server, provider calls or credentials.
 * Run with agentop run --rm -- bun scripts/metrics-journal-probe.ts <engine checkout> <opencode.db> <codex sessions> <journal.db>
 */
import { Database } from 'bun:sqlite'
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { runImport } from '../packages/server/server/journal/import'
import { buildReuseSurface } from '../packages/server/server/engine/reuse-surface'
import { loadOpencodeDb } from '../packages/server/server/adapters/opencode'
import { sessionCostUSD } from '../packages/core/src/types'
import { decodeData } from '../packages/server/server/journal/journal-plan'
import { parseCodexRolloutYielding } from '../packages/server/server/adapters/codex-parse'

const [enginePath, ocPath, codexPath, journalPath] = process.argv.slice(2)
if (!enginePath || !ocPath || !codexPath || !journalPath) throw new Error('Four input paths required; originals are read only')
const root = process.env.PROBE_REUSE ?? join(process.env.PROBE_DIR ?? tmpdir(), `journal-probe-${process.pid}`)
mkdirSync(root, { recursive: true })
const snapshot = (source: string, target: string) => {
  const db = new Database(source, { readonly: true })
  try { writeFileSync(target, db.serialize()) } finally { db.close() }
}
if (!process.env.PROBE_REUSE) {
  snapshot(ocPath, join(root, 'opencode.db'))
  snapshot(journalPath, join(root, 'journal.db'))
  cpSync(codexPath, join(root, 'codex'), { recursive: true, preserveTimestamps: true })
  const statePath = `${journalPath}.import.json`
  if (existsSync(statePath)) {
    const state = JSON.parse(readFileSync(statePath, 'utf8'))
    const st = statSync(join(root, 'journal.db'))
    state.identity = `${st.ino}:${Math.floor(st.birthtimeMs)}`
    writeFileSync(join(root, 'journal.db.import.json'), JSON.stringify(state))
  }
}
const engine = (path: string) => import(resolve(enginePath, 'engine/src', path))
const { installReaders } = await engine('reuse.ts')
installReaders(await buildReuseSurface())
const { installHost, testHost } = await engine('host.ts')
installHost(testHost(root))
const { createHarnessLive } = await engine('integrations/live/harness-live.ts')
const { createLiveFeeder } = await engine('live/feeder.ts')
const { createIntegrations } = await engine('integrations/types.ts')
const integrations = createIntegrations()
const lives = [createHarnessLive('opencode', { dir: join(root, 'opencode.db') }), createHarnessLive('codex', { dir: join(root, 'codex') })]
const fd = () => readdirSync(`/proc/${process.pid}/fd`).length
const measure = async (live: boolean) => {
  const feeder = createLiveFeeder({ lives, sink: async () => ({ append: async () => { throw new Error('Idle probe must not append') } }) })
  const before = process.cpuUsage(), start = performance.now()
  const rssBefore = process.memoryUsage().rss, fdBefore = fd()
  for (let i = 0; i < 7; i++) {
    if (live) await feeder.tick()
    await Bun.sleep(5000)
  }
  const cpu = process.cpuUsage(before), ms = performance.now() - start
  console.log(JSON.stringify({ kind: 'idle', live, elapsedMs: ms, cpuPercent: (cpu.user + cpu.system) / (ms * 10), rssBefore, rssAfter: process.memoryUsage().rss, fdBefore, fdAfter: fd(), stats: feeder.stats() }))
  feeder.stop()
}
if ((!process.env.PROBE_REUSE || process.env.PROBE_IDLE_ONLY) && !process.env.PROBE_SKIP_IDLE) {
  Bun.gc(true)
  await measure(false)
  await measure(true)
}
if (process.env.PROBE_IDLE_ONLY) process.exit(0)
const totals = () => {
  const db = new Database(join(root, 'journal.db'), { readonly: true })
  try {
    const rows = db.query<{ source_id: string; type: string; data_shape: string; data_values: string }, []>(`SELECT source_id,type,data_shape,data_values FROM events_readable WHERE source_id IN ('opencode','codex') AND type IN ('session.started','model.completed','tool.requested')`).all()
    const out: Record<string, { sessions: number; input: number; output: number; cache: number; tools: number; declaredCostUSD: number }> = {}
    for (const row of rows) {
      const t = out[row.source_id] ??= { sessions: 0, input: 0, output: 0, cache: 0, tools: 0, declaredCostUSD: 0 }
      if (row.type === 'session.started') t.sessions++
      else if (row.type === 'tool.requested') t.tools++
      else {
        const d = JSON.parse(decodeData(row.data_shape, row.data_values))
        t.input += d.usage?.input ?? 0
        t.output += (d.usage?.output ?? 0) + (d.reasoning?.billing === 'additive' ? d.reasoning.tokens : 0)
        t.cache += d.usage?.cacheRead ?? 0
        t.declaredCostUSD += d.costSource === 'harness' ? d.costUSD ?? 0 : 0
      }
    }
    return out
  } finally { db.close() }
}
console.log(JSON.stringify({ kind: 'before', totals: totals() }))
let afterFirst = ''
for (let pass = 1; pass <= (process.env.PROBE_DIFFERENTIAL_ONLY ? 0 : 2); pass++) {
  const replays = {
    opencode: createHarnessLive('opencode', { dir: join(root, 'opencode.db') }).replay,
    codex: createHarnessLive('codex', { dir: join(root, 'codex') }).replay,
  }
  const result = await runImport({ harnesses: ['opencode', 'codex'], integrations, replays, journalPath: join(root, 'journal.db'), storeDir: join(root, 'empty-store'), batchSize: 4, concurrency: 1, flushEvents: 200 })
  const current = JSON.stringify(totals())
  if (pass === 1) afterFirst = current
  else if (current !== afterFirst) throw new Error('Second import changed totals')
  console.log(JSON.stringify({ kind: 'import', pass, result, totals: JSON.parse(current) }))
}
const sessions = loadOpencodeDb(join(root, 'opencode.db'))
console.log(JSON.stringify({ kind: 'opencode-adapter', sessions: sessions.length, input: sessions.reduce((n, s) => n + (s.input_tokens ?? 0), 0), cache: sessions.reduce((n, s) => n + (s.cache_read_input_tokens ?? 0), 0), costUSD: sessions.reduce((n, s) => n + (sessionCostUSD(s) ?? 0), 0) }))
const codex = { sessions: 0, input: 0, output: 0, cache: 0, tools: 0 }
const codexById = new Map<string, { input: number; output: number; cache: number }>()
const files = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? files(join(dir, e.name)) : e.name.endsWith('.jsonl') ? [join(dir, e.name)] : [])
for (const file of files(join(root, 'codex'))) {
  const s = await parseCodexRolloutYielding(readFileSync(file, 'utf8'), file)
  if (!s) continue
  codex.sessions++; codex.input += s.input_tokens ?? 0; codex.output += s.output_tokens ?? 0; codex.cache += s.cache_read_input_tokens ?? 0
  codex.tools += Object.values(s.tool_counts ?? {}).reduce((a, b) => a + b, 0)
  codexById.set(s.session_id, { input: s.input_tokens ?? 0, output: s.output_tokens ?? 0, cache: s.cache_read_input_tokens ?? 0 })
}
console.log(JSON.stringify({ kind: 'codex-adapter', ...codex }))
const cold = createHarnessLive('codex', { dir: join(root, 'codex'), now: () => Date.now() + 120_000 }).replay
const differences: object[] = []
const coldTotal = { input: 0, output: 0, cache: 0 }
for (const source of await cold.discover()) {
  const batch = await cold.replay(source, null)
  const got = { input: 0, output: 0, cache: 0 }
  for (const e of batch.events) if (e.type === 'model.completed') {
    got.input += e.data.usage?.input ?? 0
    got.output += (e.data.usage?.output ?? 0) + (e.data.reasoning?.billing === 'additive' ? e.data.reasoning.tokens : 0)
    got.cache += e.data.usage?.cacheRead ?? 0
  }
  coldTotal.input += got.input; coldTotal.output += got.output; coldTotal.cache += got.cache
  const expected = codexById.get(source.sessionId)
  if (JSON.stringify(got) !== JSON.stringify(expected)) differences.push({ session: source.sessionId, replay: got, adapter: expected })
}
console.log(JSON.stringify({ kind: 'codex-cold-replay', totals: coldTotal, different: differences.length, examples: differences.slice(0, 5) }))
console.log(JSON.stringify({ kind: 'copy', root }))
