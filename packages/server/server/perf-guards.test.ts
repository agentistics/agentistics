/**
 * PERF GUARDS for the git workspace fallback (07/10: every data build ran git in each of the
 * hundreds of subfolders of /tmp, every 10-20 s, and froze the app).
 *
 * `git` is replaced by a shim on PATH that logs every invocation, so "how many processes were
 * spawned, and where" is counted, not assumed. One `rev-parse --show-toplevel` on the path itself
 * is legitimate (it is how a repo is recognised) — what must never happen is a spawn PER
 * SUBDIRECTORY.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SessionMeta } from '@agentistics/core'
import { getProjectGitStats } from './git'
import { resolveProjectFacts } from './data'

const SUBDIRS = 500
// Real cost is a couple of shim spawns (~tens of ms); the regression is hundreds of spawns
// (seconds). Generous enough not to flake on a loaded CI box, tight enough to bite.
const STATS_BUDGET_MS = 250
const BUILD_BUDGET_MS = 500

let base = ''
let log = ''
const saved = { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR }
let fakeTmp = ''
let fakeHome = ''
let plainFolder = ''

async function populate(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true })
  await Promise.all(Array.from({ length: SUBDIRS }, (_, i) => mkdir(join(dir, `d${i}`), { recursive: true })))
}
async function calls(): Promise<string[]> {
  try { return (await readFile(log, 'utf8')).split('\n').filter(Boolean) } catch { return [] }
}
async function reset(): Promise<void> { await writeFile(log, '') }

beforeAll(async () => {
  base = await mkdtemp(join(tmpdir(), 'perf-git-guard-'))
  log = join(base, 'git-calls.log')
  const bin = join(base, 'bin')
  await mkdir(bin, { recursive: true })
  await writeFile(join(bin, 'git'), `#!/bin/sh\necho "$@" >> "${log}"\nexit 128\n`)
  await chmod(join(bin, 'git'), 0o755)
  fakeTmp = join(base, 'faketmp')
  fakeHome = join(base, 'fakehome')
  plainFolder = join(base, 'plain')
  await Promise.all([populate(fakeTmp), populate(fakeHome), populate(plainFolder)])
  process.env.PATH = `${bin}:${saved.PATH}`
  process.env.HOME = fakeHome
  process.env.TMPDIR = fakeTmp
}, 30_000)

afterAll(async () => {
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
  await rm(base, { recursive: true, force: true })
})

describe('getProjectGitStats never fans out over subfolders', () => {
  for (const [label, get] of [
    ['the temp root', () => fakeTmp],
    ['the home folder', () => fakeHome],
    ['a non-repo folder with 500 subdirectories', () => plainFolder],
  ] as const) {
    test(label, async () => {
      await reset()
      const t0 = performance.now()
      const out = await getProjectGitStats(get())
      const ms = performance.now() - t0
      expect(out).toBeUndefined()
      expect(ms).toBeLessThan(STATS_BUDGET_MS)
      const c = await calls()
      // At most the single rev-parse on the path itself; never one per subdirectory.
      expect(c.length).toBeLessThanOrEqual(1)
      expect(c.some(line => /\/d\d+\b/.test(line))).toBe(false)
    })
  }
})

describe('the data build (resolveProjectFacts) with sessions whose cwd is a temp-like root', () => {
  test('spends a bounded number of git processes and finishes inside the budget', async () => {
    await reset()
    // Fresh folders: git.ts memoizes per path, so reusing the ones above would measure the memo.
    const buildTmp = join(base, 'buildtmp')
    const buildHome = join(base, 'buildhome')
    await Promise.all([populate(buildTmp), populate(buildHome)])
    process.env.TMPDIR = buildTmp
    process.env.HOME = buildHome
    const sessions = Array.from({ length: 40 }, (_, i) => ({
      session_id: `s${i}`, project_path: i % 2 ? buildTmp : buildHome, start_time: '2026-10-01T10:00:00Z',
    })) as unknown as SessionMeta[]
    const t0 = performance.now()
    await resolveProjectFacts(sessions, [], new Set())
    const ms = performance.now() - t0
    expect(ms).toBeLessThan(BUILD_BUDGET_MS)
    const c = await calls()
    expect(c.length).toBeLessThanOrEqual(8) // two paths x (rev-parse + remote read), not 2 x 500
    expect(c.some(line => /\/d\d+\b/.test(line))).toBe(false)
  })
})
