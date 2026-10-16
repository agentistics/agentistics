/**
 * PLAN.ACCOUNTS D2 through the WHOLE build, in consolidate mode (the default), over two builds.
 *
 * A second claude account root must never move the Claude stats-cache totals, must not be listed
 * twice in its project, and must show its FRESH data on the second build — the bug this pins revived
 * the previous build's stored copy as a default-root Claude row (into `supplementStatsCache`, and
 * ahead of the fresh copy in the final dedup). The default root's sessions carry its bound account.
 *
 * The build keeps per-file state in module memory, so each scenario runs in its own child process
 * over a throwaway HOME (same shape as rebuild-incremental.test.ts).
 */
import { test, expect } from 'bun:test'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SCRIPT = `
import { writeFileSync, utimesSync } from 'node:fs'
import { join } from 'node:path'
const [out, withAccounts, rootB] = [process.argv[2]!, process.argv[3] === '1', process.argv[4]!]
const { AGENTISTICS_DATA_DIR } = await import('./config')
if (withAccounts) {
  const { createHarnessAccounts } = await import('./harness-accounts')
  const store = createHarnessAccounts({ file: join(AGENTISTICS_DATA_DIR, 'accounts.json'), probe: async () => ({ key: 'k', label: 'k' }) })
  await store.bind(null, { harness: 'claude', key: 'main', label: 'main' })
  await store.bind(rootB, { harness: 'claude', key: 'second', label: 'second' })
}
const data = await import('./data')
const pick = (r: any) => ({
  statsCache: r.statsCache,
  sessions: r.sessions.filter((s: any) => (s.harness ?? 'claude') === 'claude').map((s: any) => ({ id: s.session_id, account: s.account ?? null, prompt: s.first_prompt })).sort((a: any, b: any) => a.id.localeCompare(b.id)),
  project: (r.projects.find((p: any) => p.path === '/p')?.sessions ?? []).map((s: any) => s.sessionId).sort(),
})
const first = pick(await data.buildApiResponse())
// The second root's session changes between the builds: build 2 must show the new text.
const metaB = join(rootB, 'usage-data', 'session-meta', 's1.json')
const doc = JSON.parse(await Bun.file(metaB).text()); doc.first_prompt = 'second build'
writeFileSync(metaB, JSON.stringify(doc)); const t = new Date(Date.now() + 5000); utimesSync(metaB, t, t)
await data.rebuildNow()
const second = pick(await data.buildApiResponse())
// The adapter's own read, whose DEFAULT root goes through the module's constants (isDefault).
const { claudeAdapter } = await import('./adapters/claude')
const adapter = (await claudeAdapter.loadSessions()).map((s: any) => [s.session_id, s.account ?? null]).sort()
writeFileSync(out, JSON.stringify({ first, second, adapter }))
process.exit(0)
`

const writeJson = (path: string, value: unknown) => { mkdirSync(join(path, '..'), { recursive: true }); writeFileSync(path, JSON.stringify(value)) }

function scenario(withAccounts: boolean): { first: any; second: any; adapter: any[] } {
  const home = mkdtempSync(join(tmpdir(), 'data-account-roots-'))
  const script = join(import.meta.dir, `.data-account-roots-${process.pid}-${withAccounts ? 1 : 0}.ts`)
  try {
    const claude = join(home, '.claude'), rootB = join(home, 'claude-b')
    writeJson(join(claude, 'stats-cache.json'), {
      version: 2, lastComputedDate: '2026-01-01', totalSessions: 10, totalMessages: 100,
      dailyActivity: [{ date: '2026-01-01', messageCount: 100, sessionCount: 10, toolCallCount: 5 }],
      dailyModelTokens: [], modelUsage: {},
    })
    const meta = (id: string, prompt: string) => ({
      session_id: id, project_path: '/p', start_time: '2026-05-01T10:00:00.000Z', duration_minutes: 5,
      user_message_count: 3, assistant_message_count: 3, first_prompt: prompt, input_tokens: 10, output_tokens: 20,
    })
    writeJson(join(claude, 'usage-data', 'session-meta', 'd1.json'), meta('d1', 'default'))
    writeJson(join(rootB, 'usage-data', 'session-meta', 's1.json'), meta('s1', 'first build'))
    writeJson(join(home, '.agentistics', 'preferences.json'), { archiveMode: 'consolidate' })
    writeFileSync(script, SCRIPT)
    const out = join(home, 'out.json')
    const env: Record<string, string | undefined> = { ...process.env, HOME: home, AGENTISTICS_DIR: join(home, '.agentistics'), AGENTISTICS_TELEMETRY: '0', AGENTISTICS_JOURNAL: '0' }
    delete env.CLAUDE_DIR; delete env.CLAUDE_CONFIG_DIR
    const p = Bun.spawnSync([process.execPath, script, out, withAccounts ? '1' : '0', rootB], { env: env as Record<string, string>, cwd: import.meta.dir, stdout: 'pipe', stderr: 'pipe' })
    if (p.exitCode !== 0) throw new Error(`exited ${p.exitCode}: ${p.stderr.toString().slice(-2000)}`)
    return JSON.parse(readFileSync(out, 'utf-8'))
  } finally {
    rmSync(script, { force: true })
    rmSync(home, { recursive: true, force: true })
  }
}

let cached: { none: ReturnType<typeof scenario>; acc: ReturnType<typeof scenario> } | null = null
const both = () => (cached ??= { none: scenario(false), acc: scenario(true) })

test('a second claude root never moves the stats cache, is listed once, and is fresh on build 2', () => {
  const { none, acc } = both()
  // No accounts: only the default root, and the two builds agree.
  expect(none.first.sessions.map((s: any) => s.id)).toEqual(['d1'])
  expect(none.second).toEqual(none.first)
  // Stats-cache totals: identical with and without the second root, on BOTH builds.
  expect(acc.first.statsCache).toEqual(none.first.statsCache)
  expect(acc.second.statsCache).toEqual(none.first.statsCache)
  for (const build of [acc.first, acc.second]) {
    expect(build.sessions.map((s: any) => s.id)).toEqual(['d1', 's1'])
    // Listed in its project exactly once (meta-only default sessions get no project entry here).
    expect(build.project.filter((id: string) => id === 's1')).toEqual(['s1'])
    expect(new Set(build.project).size).toBe(build.project.length)
  }
  // Fresh data on the second build, not the stored copy of the first.
  expect(acc.first.sessions[1].prompt).toBe('first build')
  expect(acc.second.sessions[1].prompt).toBe('second build')
}, 120_000)

test('the default claude root is stamped with its bound account (spec §4 D8) in the build and the adapter', () => {
  const { none, acc } = both()
  // The default root is stamped with its bound account; the second root with its own.
  const [d1, s1] = acc.second.sessions
  expect(acc.first.sessions[0].account).toBe(d1.account)
  expect(d1.account).toBeTruthy()
  expect(s1.account).toBeTruthy()
  expect(s1.account).not.toBe(d1.account)
  expect(none.first.sessions[0].account).toBeNull()
  // The adapter reads the default root through its default branch and stamps it the same way.
  expect(none.adapter).toEqual([['d1', null]])
  expect(acc.adapter).toEqual([['d1', d1.account], ['s1', s1.account]])
}, 120_000)
