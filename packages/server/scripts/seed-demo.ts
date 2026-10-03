/**
 * seed-demo.ts — builds a PRIVACY-SAFE demo machine home for recordings.
 *
 * Release GIFs and site screenshots are published, so they must never carry a
 * real project name, repository, file path or prompt. This script derives a
 * demo home from THIS machine's data and rewrites every identifying field
 * through a stable pseudonym map, keeping the numbers untouched — token
 * counts, timestamps, durations and tool distributions stay exactly as they
 * are, so the charts are real shapes with fictional labels.
 *
 * It reads only two things, neither of which holds chat:
 *   - the consolidate store (`~/.agentistics/sessions/<harness>/*.json`,
 *     one SessionMeta per session)
 *   - `~/.claude/stats-cache.json` (Claude-only daily aggregates)
 *
 * Raw transcripts (`~/.claude/projects/**​/*.jsonl`) are NEVER read, so no chat
 * text can reach the output by construction.
 *
 * Usage:
 *   bun run packages/server/scripts/seed-demo.ts [--out <dir>] [--force]
 *   bun run packages/server/scripts/seed-demo.ts --split 3 --force
 *   HOME=<dir> agentop server        # run the demo machine against it
 *
 * `--split <n>` writes n sibling homes (`<out>-1`, `<out>-2`, …) instead of one,
 * partitioning the sessions by project so each machine has its own working set.
 * Some repositories are deliberately left on more than one machine: a central
 * only shows cross-machine repository grouping, per-machine filters and the
 * sibling sharing-rule warnings when the same repo genuinely appears twice.
 *
 * Default output: ~/.agentistics-demo-home
 */

import { mkdir, readdir, readFile, writeFile, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import type { SessionMeta, HarnessId } from '@agentistics/core'

const HOME = process.env.HOME ?? ''
const REAL_STORE = join(HOME, '.agentistics', 'sessions')
const REAL_STATS = join(HOME, '.claude', 'stats-cache.json')

const argv = process.argv.slice(2)
const outFlag = argv.indexOf('--out')
const OUT_HOME = outFlag >= 0 ? argv[outFlag + 1]! : join(HOME, '.agentistics-demo-home')
const FORCE = argv.includes('--force')
const splitFlag = argv.indexOf('--split')
const SPLIT = splitFlag >= 0 ? Math.max(1, parseInt(argv[splitFlag + 1] ?? '1', 10)) : 1

/** Which machines a demo project lives on. Most sit on exactly one; the first
 *  three are shared, because the cross-machine views (repository grouping, the
 *  per-machine filter, the sibling withheld-repository warning) are only
 *  demonstrable when one repository is genuinely present on two machines. */
function machinesFor(projectName: string, total: number): number[] {
  if (total === 1) return [0]
  const shared = ['atlas-api', 'harbor-web', 'kiln']
  if (shared.includes(projectName)) return [0, 1 % total]
  const h = createHash('sha256').update('machine\0' + projectName).digest()
  return [h.readUInt32BE(0) % total]
}

/* ------------------------------------------------------------------ names */

/** Fictional projects. Each is a plausible product a team would actually have,
 *  so the dashboard reads as a real workspace rather than as `project-1`. */
const PROJECTS = [
  { name: 'atlas-api', org: 'northwind', lang: 'TypeScript' },
  { name: 'harbor-web', org: 'northwind', lang: 'TypeScript' },
  { name: 'beacon-ingest', org: 'northwind', lang: 'Python' },
  { name: 'quarry', org: 'northwind', lang: 'Rust' },
  { name: 'lantern-docs', org: 'northwind', lang: 'Markdown' },
  { name: 'ferry-mobile', org: 'northwind', lang: 'Swift' },
  { name: 'kiln', org: 'orbital-labs', lang: 'Go' },
  { name: 'sundial', org: 'orbital-labs', lang: 'TypeScript' },
  { name: 'mercator', org: 'orbital-labs', lang: 'Python' },
  { name: 'tidepool', org: 'orbital-labs', lang: 'TypeScript' },
  { name: 'foundry-cli', org: 'stillwater', lang: 'Rust' },
  { name: 'cobblestone', org: 'stillwater', lang: 'Go' },
  { name: 'peregrine', org: 'stillwater', lang: 'TypeScript' },
  { name: 'saltmarsh', org: 'stillwater', lang: 'Python' },
  { name: 'driftwood', org: 'stillwater', lang: 'TypeScript' },
  { name: 'greenhouse', org: 'fieldnotes', lang: 'TypeScript' },
  { name: 'almanac', org: 'fieldnotes', lang: 'Python' },
  { name: 'windrose', org: 'fieldnotes', lang: 'Go' },
  { name: 'clearwater', org: 'fieldnotes', lang: 'TypeScript' },
  { name: 'stonebridge', org: 'fieldnotes', lang: 'Java' },
] as const

/** Fictional prompts, chosen to look like ordinary engineering work and to
 *  never resemble a credential, a customer name or an internal system. */
const PROMPTS = [
  'Add pagination to the sessions endpoint',
  'Why does the retry loop double-count failed jobs?',
  'Extract the pricing table into its own module',
  'Write tests for the date-window filter',
  'Migrate the config loader off the deprecated API',
  'Fix the flaky upload test on CI',
  'Refactor the auth middleware to return typed errors',
  'Add a dark theme to the settings screen',
  'Profile the slow query on the reports page',
  'Document the deployment steps for the staging cluster',
  'Split the monolithic reducer into slices',
  'Handle the empty state on the dashboard',
  'Cache the remote lookup for 5 minutes',
  'Convert the build script to TypeScript',
  'Add a health check endpoint',
  'Fix the off-by-one in the pagination cursor',
  'Rename the legacy fields in the API response',
  'Add retry with backoff to the webhook sender',
  'Investigate the memory growth in the worker',
  'Set up the integration test harness',
]

const AGENT_TASKS = [
  'search for the failing assertion',
  'review the migration for lost rows',
  'find every call site of the old helper',
  'summarize the changed files',
  'check the tests cover the new branch',
  'trace where the value is set',
]

const FILES = [
  'src/index.ts', 'src/server/routes.ts', 'src/lib/format.ts', 'src/hooks/useData.ts',
  'src/components/Table.tsx', 'tests/api.test.ts', 'README.md', 'package.json',
  'src/store/session.ts', 'src/workers/queue.ts', 'docs/architecture.md',
]

const USERS = ['ana', 'bruno', 'chen', 'dara', 'emil', 'farid']
const MACHINES = ['workstation', 'laptop', 'devbox', 'mac-mini']

/* ------------------------------------------------------------- pseudonyms */

/** Stable, deterministic index for a real value — the same real project always
 *  maps to the same fictional one across runs, so a re-record does not shuffle
 *  every label in the screenshots. */
function pick<T>(pool: readonly T[], key: string, salt = ''): T {
  const h = createHash('sha256').update(salt + '\0' + key).digest()
  return pool[h.readUInt32BE(0) % pool.length]!
}

const projectOf = (realPath: string) => pick(PROJECTS, realPath, 'project')

function demoPath(realPath: string): string {
  if (!realPath) return realPath
  const p = projectOf(realPath)
  return `/home/dev/code/${p.name}`
}

function demoRemote(realRemote: string | undefined, realPath: string): string | undefined {
  if (realRemote === undefined) return undefined
  if (realRemote === '') return ''
  const p = projectOf(realPath || realRemote)
  return `github.com/${p.org}/${p.name}`
}

const demoPrompt = (real: string, key: string) => (real ? pick(PROMPTS, key, 'prompt') : real)
const demoUser = (real: string | undefined, key: string) =>
  real === undefined ? undefined : `${pick(USERS, key, 'user')}-${pick(MACHINES, key, 'machine')}`

/** A session id is not itself identifying, but it appears in URLs next to
 *  pseudonymized data; rehashing keeps the demo home internally consistent
 *  while making it impossible to correlate a shot back to a real session. */
const demoId = (real: string) =>
  createHash('sha256').update('demo-session\0' + real).digest('hex').slice(0, 32)
    .replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5')

/* -------------------------------------------------------------- transform */

function scrubSession(real: SessionMeta): SessionMeta {
  const key = real.session_id || real.project_path
  const proj = projectOf(real.project_path)
  const out: SessionMeta = {
    ...real,
    session_id: demoId(real.session_id),
    project_path: demoPath(real.project_path),
    first_prompt: demoPrompt(real.first_prompt, key),
    languages: real.languages.length ? [proj.lang] : [],
  }

  if (real.current_cwd !== undefined) out.current_cwd = demoPath(real.current_cwd)
  if (real.title !== undefined) out.title = real.title ? pick(PROMPTS, key, 'title') : real.title
  if (real.git_remote !== undefined) out.git_remote = demoRemote(real.git_remote, real.project_path)
  if (real.user !== undefined) out.user = demoUser(real.user, real.user)

  // agent_file_reads is keyed by real file paths.
  if (real.agent_file_reads && Object.keys(real.agent_file_reads).length) {
    const reads: Record<string, number> = {}
    for (const [file, n] of Object.entries(real.agent_file_reads)) {
      const name = pick(FILES, file, 'file')
      reads[name] = (reads[name] ?? 0) + n
    }
    out.agent_file_reads = reads
  }

  // agentMetrics carries a free-text description per invocation.
  if (real.agentMetrics) {
    out.agentMetrics = {
      ...real.agentMetrics,
      invocations: real.agentMetrics.invocations.map((inv, i) => ({
        ...inv,
        description: pick(AGENT_TASKS, key + ':' + i, 'agent'),
      })),
    }
  }

  return out
}

/* ------------------------------- synthetic sessions for unused harnesses */

/** Kimi Code and Antigravity are supported but may have no local history on
 *  the recording host. Compare-page and harness-selector shots are only honest
 *  if every harness the build claims actually appears, so a small, clearly
 *  synthetic set is generated for the ones with no data — derived from the
 *  real sessions' time distribution so the activity charts stay plausible. */
function synthesize(harness: HarnessId, count: number, template: SessionMeta[]): SessionMeta[] {
  if (!template.length) return []
  const MODELS: Record<string, string> = {
    kimi: 'gemini-3.5-flash-lite',
    antigravity: 'gemini-3.6-flash',
  }
  const out: SessionMeta[] = []
  for (let i = 0; i < count; i++) {
    const base = template[(i * 7) % template.length]!
    const key = `${harness}:${i}`
    const proj = pick(PROJECTS, key, 'project')
    const scale = 0.35 + ((i % 5) * 0.15)
    out.push({
      ...base,
      session_id: demoId(`${harness}-synthetic-${i}`),
      project_path: `/home/dev/code/${proj.name}`,
      current_cwd: undefined,
      git_remote: `github.com/${proj.org}/${proj.name}`,
      first_prompt: pick(PROMPTS, key, 'prompt'),
      title: undefined,
      languages: [proj.lang],
      harness,
      model: MODELS[harness],
      model_usage: undefined,
      user: undefined,
      input_tokens: Math.round(base.input_tokens * scale),
      output_tokens: Math.round(base.output_tokens * scale),
      cache_read_input_tokens: Math.round((base.cache_read_input_tokens ?? 0) * scale),
      cache_creation_input_tokens: harness === 'antigravity'
        ? 0 // agy records no cache-write counter
        : Math.round((base.cache_creation_input_tokens ?? 0) * scale),
      agentMetrics: undefined, // neither harness produces agent metrics
      uses_task_agent: false,
      agent_file_reads: {},
    })
  }
  return out
}

/* ------------------------------------------------------------------- main */

async function readStore(): Promise<Map<HarnessId, SessionMeta[]>> {
  const byHarness = new Map<HarnessId, SessionMeta[]>()
  const add = (h: HarnessId, s: SessionMeta) => {
    const list = byHarness.get(h) ?? []
    list.push(s)
    byHarness.set(h, list)
  }

  const entries = await readdir(REAL_STORE, { withFileTypes: true }).catch(() => [])
  for (const entry of entries) {
    // Legacy flat files at the root load as claude, same as the server does.
    const files = entry.isDirectory()
      ? (await readdir(join(REAL_STORE, entry.name))).map(f => join(REAL_STORE, entry.name, f))
      : entry.name.endsWith('.json') ? [join(REAL_STORE, entry.name)] : []
    for (const file of files) {
      if (!file.endsWith('.json')) continue
      const raw = await readFile(file, 'utf8').catch(() => null)
      if (!raw) continue
      let session: SessionMeta
      try { session = JSON.parse(raw) as SessionMeta } catch { continue }
      // A session with no start time contributes nothing to any chart.
      if (!session.start_time) continue
      // Native sessions are synthesized from the journal, never stored — nothing to seed from.
      if (session.harness === 'agentistics') continue
      add(session.harness ?? 'claude', session)
    }
  }
  return byHarness
}

/** Writes one demo home. `machine` is its index in a `--split` run; -1 means
 *  the single-home case, where every session belongs to it. */
async function writeHome(
  home: string,
  machine: number,
  byHarness: Map<HarnessId, SessionMeta[]>,
  statsRaw: string | null,
): Promise<number> {
  const exists = await stat(home).then(() => true).catch(() => false)
  if (exists && !FORCE) throw new Error(`${home} already exists — pass --force to rebuild it`)
  if (exists) await rm(home, { recursive: true, force: true })

  let written = 0
  const perHarness: string[] = []
  for (const [harness, sessions] of byHarness) {
    const mine = machine < 0
      ? sessions
      : sessions.filter(s => {
          const name = s.project_path.split('/').filter(Boolean).pop() ?? ''
          return machinesFor(name, SPLIT).includes(machine)
        })
    if (!mine.length) continue
    const dir = join(home, '.agentistics', 'sessions', harness)
    await mkdir(dir, { recursive: true })
    for (const session of mine) {
      await writeFile(join(dir, `${session.session_id}.json`), JSON.stringify(session))
      written++
    }
    perHarness.push(`${harness} ${mine.length}`)
  }

  await mkdir(join(home, '.claude'), { recursive: true })
  if (statsRaw) {
    // stats-cache.json holds daily aggregates and no identifying strings apart
    // from the longest session's id, which is rehashed like every other id.
    const stats = JSON.parse(statsRaw) as Record<string, unknown>
    const longest = stats.longestSession as { sessionId?: string } | undefined
    if (longest?.sessionId) longest.sessionId = demoId(longest.sessionId)
    // In a split run the Claude-only cache would otherwise report the SAME
    // full-history totals on every machine, so the central would show three
    // machines each claiming all of it. Scale it down to this machine's share.
    if (machine >= 0) scaleStats(stats, written, [...byHarness.values()].reduce((n, l) => n + l.length, 0))
    await writeFile(join(home, '.claude', 'stats-cache.json'), JSON.stringify(stats))
  }

  // Pre-answer the archive consent gate so a recording never opens on the modal,
  // and pin 'consolidate' — the store above IS the demo machine's whole history.
  await writeFile(
    join(home, '.agentistics', 'preferences.json'),
    JSON.stringify({ archiveMode: 'consolidate', lang: 'en', theme: 'dark' }, null, 2),
  )

  console.log(`  ${home}`)
  console.log(`    ${written} sessions — ${perHarness.join(', ')}`)
  return written
}

/** The Claude stats cache carries no project dimension, so it cannot be split
 *  by project the way the sessions are. Scaling every count by this machine's
 *  share of the sessions keeps the three demo machines from each reporting the
 *  whole fleet's history — the shapes stay real, the totals stay plausible. */
function scaleStats(stats: Record<string, unknown>, mine: number, total: number): void {
  const f = total > 0 ? mine / total : 1
  const n = (v: unknown) => (typeof v === 'number' ? Math.max(1, Math.round(v * f)) : v)
  stats.totalSessions = n(stats.totalSessions)
  stats.totalMessages = n(stats.totalMessages)
  for (const day of (stats.dailyActivity as Record<string, unknown>[] | undefined) ?? []) {
    day.messageCount = n(day.messageCount)
    day.sessionCount = n(day.sessionCount)
    day.toolCallCount = n(day.toolCallCount)
  }
  for (const day of (stats.dailyModelTokens as Record<string, unknown>[] | undefined) ?? []) {
    const byModel = day.tokensByModel as Record<string, number> | undefined
    for (const k of Object.keys(byModel ?? {})) byModel![k] = n(byModel![k]) as number
  }
  const usage = stats.modelUsage as Record<string, Record<string, number>> | undefined
  for (const model of Object.values(usage ?? {})) {
    for (const k of Object.keys(model)) model[k] = n(model[k]) as number
  }
  const hours = stats.hourCounts as Record<string, number> | undefined
  for (const k of Object.keys(hours ?? {})) hours![k] = n(hours![k]) as number
}

async function run(): Promise<void> {
  if (!HOME) throw new Error('HOME is not set')

  const real = await readStore()
  const realCount = [...real.values()].reduce((n, l) => n + l.length, 0)
  if (!realCount) {
    throw new Error(
      `no sessions found in ${REAL_STORE} — run agentistics in 'consolidate' archive mode first`,
    )
  }

  const claude = real.get('claude') ?? []
  for (const [harness, count] of [['kimi', 9], ['antigravity', 7]] as const) {
    if (!(real.get(harness)?.length)) real.set(harness, synthesize(harness, count, claude))
  }

  // Scrub once, up front, so every home is written from the same pseudonymized
  // set — a session must not land on two machines under two different names.
  const scrubbed = new Map<HarnessId, SessionMeta[]>()
  for (const [harness, sessions] of real) {
    const isSynthetic = harness === 'kimi' || harness === 'antigravity'
    scrubbed.set(harness, sessions.map(s => (isSynthetic && !s.agentMetrics ? s : scrubSession(s))))
  }

  const statsRaw = await readFile(REAL_STATS, 'utf8').catch(() => null)

  console.log()
  let total = 0
  if (SPLIT === 1) {
    total = await writeHome(OUT_HOME, -1, scrubbed, statsRaw)
  } else {
    for (let i = 0; i < SPLIT; i++) {
      total += await writeHome(`${OUT_HOME}-${i + 1}`, i, scrubbed, statsRaw)
    }
  }

  console.log(`\n${total} sessions across ${scrubbed.size} harnesses`)
  console.log(
    SPLIT === 1
      ? `\nrun it with:\n  HOME=${OUT_HOME} agentop server`
      : `\nrun them with:\n${Array.from({ length: SPLIT }, (_, i) =>
          `  HOME=${OUT_HOME}-${i + 1} PORT=${47391 + i * 10} agentop server`).join('\n')}`,
  )
}

await run()
