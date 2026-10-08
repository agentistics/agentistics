/**
 * scripts/perf/rebuild-bench.ts — what one `/api/data` rebuild costs, step by step (PERF.1 step 1).
 *
 * Run with HOME pointing at a synthetic home (`synth-home.ts` + `synth-harnesses.ts`), NEVER a real
 * one: the build writes its consolidate store under `$HOME/.agentistics`.
 *
 *   HOME=/tmp/fx bun scripts/perf/rebuild-bench.ts [--rounds 3]
 *
 * Prints the build timer line (`[data] built in …`) for: the cold first build, unchanged rebuilds,
 * a rebuild after one Claude transcript grew, and one after one Codex rollout grew — plus a hash of
 * the serialized response so two runs (or two implementations) can be compared byte for byte.
 */
import { appendFileSync, mkdirSync, readdirSync, writeFileSync, existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'

const home = process.env.HOME ?? ''
if (!existsSync(join(home, '.claude', 'projects'))) { console.error('HOME is not a synthetic home (no .claude/projects)'); process.exit(2) }
const rounds = (() => { const i = process.argv.indexOf('--rounds'); return i >= 0 ? Number(process.argv[i + 1]) : 3 })()

mkdirSync(join(home, '.agentistics'), { recursive: true })
const prefs = join(home, '.agentistics', 'preferences.json')
if (!existsSync(prefs)) writeFileSync(prefs, JSON.stringify({ archiveMode: 'consolidate' }))

const data = await import('../../packages/server/server/data.ts')
const hash = (d: object) => createHash('sha256').update(data.serializedData(d as never)).digest('hex').slice(0, 16)

async function timed(label: string, f: () => Promise<unknown>): Promise<number> {
  const t = performance.now()
  await f()
  const ms = Math.round(performance.now() - t)
  const d = await data.buildApiResponse()
  console.log(`## ${label}: ${ms} ms  hash=${hash(d)}`)
  return ms
}

function firstFile(dir: string, test: (n: string) => boolean): string {
  for (const n of readdirSync(dir).sort()) {
    const p = join(dir, n)
    if (statSync(p).isDirectory()) { const r = firstFile(p, test); if (r) return r }
    else if (test(n)) return p
  }
  return ''
}

await timed('cold first build', () => data.buildApiResponse())
for (let i = 0; i < rounds; i++) await timed(`unchanged rebuild ${i + 1}`, () => data.rebuildNow())

const claudeFile = firstFile(join(home, '.claude', 'projects'), n => n.endsWith('.jsonl'))
for (let i = 0; i < rounds; i++) {
  appendFileSync(claudeFile, JSON.stringify({ type: 'user', sessionId: 'x', uuid: crypto.randomUUID(), timestamp: new Date().toISOString(), message: { role: 'user', content: `appended ${i}` } }) + '\n')
  await timed(`claude append ${i + 1}`, () => data.rebuildNow())
}
const codexDir = join(home, '.codex', 'sessions')
if (existsSync(codexDir)) {
  const codexFile = firstFile(codexDir, n => n.startsWith('rollout-'))
  for (let i = 0; i < rounds; i++) {
    appendFileSync(codexFile, JSON.stringify({ timestamp: new Date().toISOString(), type: 'event_msg', payload: { type: 'user_message', message: `appended ${i}` } }) + '\n')
    await timed(`codex append ${i + 1}`, () => data.rebuildNow())
  }
}
process.exit(0)
