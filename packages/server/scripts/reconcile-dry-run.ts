/**
 * Cold, read-only measurement of the delivery reconcile against a COPY of the real board and session registry.
 *
 *   AGENTISTICS_DIR=<empty throwaway dir> GH_TOKEN=... \
 *     agentop run --rm -- bun packages/server/scripts/reconcile-dry-run.ts --from ~/.agentistics [--budget 1500] [--runs 1] [--out report.json]
 *
 * What it does: copies ONLY `tasks.json`, `deliveries.json` and `managed-sessions.json` from `--from` into the throwaway
 * AGENTISTICS_DIR (never `structured/`, never the vault or preferences), builds the ordinary delivery service over it and
 * calls `reconcile({}, 'owner')` — a DRY run: it never applies, never starts a server, a scheduler or the tick, and never
 * types into a session. The only things written are inside the throwaway dir (the proof cache). It reads GitHub through
 * `gh` (set GH_TOKEN; a throwaway HOME has no gh login), so the call count and time are the real cold cost.
 *
 * `--runs N` repeats the run in the same process (`--budget 250` shows the automatic run's share of the quota: each run
 * resumes where the previous stopped). The report ends with a run after a simulated RESTART (a fresh service over the
 * same cache file) to show that what gh already answered survives.
 */
import { copyFile, mkdir, stat, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const arg = (name: string, fallback?: string): string | undefined => {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : fallback
}
// `agentop run --rm` gives the command its own HOME (and drops AGENTISTICS_DIR), so the data dir is that HOME's `.agentistics`.
// The real one is found through the passwd entry, which a changed HOME cannot move.
const dir = resolve(process.env.AGENTISTICS_DIR ?? join(process.env.HOME ?? '', '.agentistics'))
// (`os.userInfo().homedir` follows $HOME in Bun, so it cannot be used: the passwd entry is read directly.)
const passwdHome = readFileSync('/etc/passwd', 'utf8').split('\n').map(l => l.split(':')).find(f => Number(f[2]) === process.getuid?.())?.[5] ?? ''
const real = resolve(join(passwdHome, '.agentistics'))
if (!process.env.HOME || !passwdHome || dir === real || !(process.env.AGENTISTICS_THROWAWAY || process.env.AGENTISTICS_DIR)) { console.error('refusing: run it inside `agentop run --rm` (or set AGENTISTICS_DIR to an EMPTY THROWAWAY directory) — never against the real ~/.agentistics'); process.exit(2) }
process.env.AGENTISTICS_DIR = dir
const from = resolve(arg('from', real)!)
if (from === dir) { console.error('refusing: --from and AGENTISTICS_DIR are the same directory'); process.exit(2) }
const budget = Number(arg('budget', '1500'))
const runs = Math.max(1, Number(arg('runs', '1')))
const out = arg('out')

await mkdir(dir, { recursive: true })
const copied: Record<string, number | null> = {}
for (const name of ['tasks.json', 'deliveries.json', 'managed-sessions.json']) {
  try { await copyFile(join(from, name), join(dir, name)); copied[name] = (await stat(join(dir, name))).size } catch { copied[name] = null }
}

// Imported only now: the config module reads AGENTISTICS_DIR when it is first loaded.
const { deliveryService } = await import('../server/delivery/host')
const lines: string[] = []
const summarize = (r: Awaited<ReturnType<ReturnType<typeof deliveryService>['reconcile']>>, ms: number) => {
  if (!r.ok) return { ok: false, sentence: r.sentence }
  const by = (k: 'published' | 'unchecked' | 'antiga') => r.entries.filter(e => (k === 'published' ? e.to === 'publicado' : k === 'unchecked' ? e.unchecked : e.bucket === 'antiga')).length
  return { ok: true, gh: r.gh, ms: Math.round(ms), stopped: r.stopped ?? null, summary: r.summary, pieces: r.entries.length, publishedEntries: by('published'), uncheckedEntries: by('unchecked'), antigaEntries: by('antiga'), unchecked: Object.fromEntries(['no-repos', 'gh', 'budget'].map(w => [w, r.entries.filter(e => e.unchecked === w).length])) }
}
const reportRuns: unknown[] = []
const run = async (label: string, svc: ReturnType<typeof deliveryService>) => {
  const t0 = performance.now()
  const r = await svc.reconcile({}, 'owner', { budget })
  const row = { label, ...summarize(r, performance.now() - t0) }
  reportRuns.push(row)
  lines.push(JSON.stringify(row))
  console.log(JSON.stringify(row))
  return r
}

const svc = deliveryService({ log: () => undefined })
let last
for (let i = 1; i <= runs; i++) last = await run(`run ${i} (budget ${budget})`, svc)
// A restart: a fresh service over the same cache file asks only for what is new.
const afterRestart = deliveryService({ log: () => undefined })
const final = await run(`after restart (budget ${budget})`, afterRestart)

if (final.ok) {
  const watch = process.argv.includes('--watch') ? process.argv[process.argv.indexOf('--watch') + 1]!.split(',') : ['s-0d52abbbc2']
  for (const id of watch) {
    const e = final.entries.find(x => x.subtaskId === id) ?? (last?.ok ? last.entries.find(x => x.subtaskId === id) : undefined)
    console.log(`piece ${id}: ${e ? JSON.stringify({ to: e.to, tag: e.tag, via: e.via, pr: e.pr, repo: e.repo, bucket: e.bucket, unchecked: e.unchecked, reason: e.reason }) : 'not among the pieces judged'}`)
  }
}
if (out) await writeFile(out, JSON.stringify({ copied, runs: reportRuns, entries: final.ok ? final.entries : [] }, null, 1))
