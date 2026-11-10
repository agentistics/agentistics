import { afterEach, describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gitTestEnv } from '@agentistics/core/gitTestEnv'
import { applyClean, cwdInside, isRegenerable, openSessionCwds, parseDu, repoOf, worktreeFacts, WORKTREE_POOL_SIZE } from './clean-io'
import { planClean } from './clean-plan'

const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })
const env = gitTestEnv()
const g = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, env: gitTestEnv(), encoding: 'utf8' })

function repo() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'clean-'))); dirs.push(root)
  const r = join(root, 'repo'); mkdirSync(r)
  g(r, 'init', '-q', '-b', 'main'); g(r, 'config', 'user.email', 't@t'); g(r, 'config', 'user.name', 't'); g(r, 'config', 'commit.gpgsign', 'false'); writeFileSync(join(r, 'a'), '1'); g(r, 'add', '.'); g(r, 'commit', '-qm', 'one')
  // merged: a branch whose commit main already has
  g(r, 'worktree', 'add', '-q', join(root, 'merged'), '-b', 'done')
  // unmerged, with node_modules
  g(r, 'worktree', 'add', '-q', join(root, 'wip'), '-b', 'wip')
  writeFileSync(join(root, 'wip', 'b'), '2'); g(join(root, 'wip'), 'add', '.'); g(join(root, 'wip'), 'commit', '-qm', 'wip')
  mkdirSync(join(root, 'wip', 'node_modules', 'x'), { recursive: true }); writeFileSync(join(root, 'wip', 'node_modules', 'x', 'f'), 'x'.repeat(10000))
  writeFileSync(join(root, 'wip', '.gitignore'), 'node_modules\n'); g(join(root, 'wip'), 'add', '.'); g(join(root, 'wip'), 'commit', '-qm', 'ignore')
  // merged but dirty
  g(r, 'worktree', 'add', '-q', join(root, 'dirty'), '-b', 'dirty')
  writeFileSync(join(root, 'dirty', 'new'), 'x')
  return { root, r }
}

describe('clean io (real git)', () => {
  test('uses a bounded worktree inspection pool', () => {
    expect(WORKTREE_POOL_SIZE).toBeGreaterThan(1)
    expect(WORKTREE_POOL_SIZE).toBeLessThanOrEqual(8)
  })

  test('facts, plan and apply: merged+clean removed, dirty kept, stale node_modules removed, branches kept', async () => {
    const { root, r } = repo()
    expect(await repoOf(join(root, 'wip'), { env })).toBe(r)
    const facts = await worktreeFacts(r, { env })
    const by = (p: string) => facts.find(f => f.path === join(root, p))!
    expect(facts.find(f => f.isMain)!.path).toBe(r)
    expect(by('merged')).toMatchObject({ merged: true, dirty: false })
    expect(by('wip')).toMatchObject({ merged: false, dirty: false })
    expect(by('wip').nodeModulesBytes).toBeGreaterThan(0)
    expect(by('dirty')).toMatchObject({ merged: true, dirty: true })
    // "now" far enough ahead that wip is stale
    const plan = planClean(facts, Date.now() + 40 * 86_400_000)
    expect(await applyClean(plan, { env })).toEqual([])
    expect(existsSync(join(root, 'merged'))).toBe(false)
    expect(existsSync(join(root, 'dirty', 'new'))).toBe(true)
    expect(existsSync(join(root, 'wip', 'b'))).toBe(true)
    expect(existsSync(join(root, 'wip', 'node_modules'))).toBe(false)
    expect(g(r, 'branch', '--list', 'done').trim()).toContain('done')
  })

  test('squash-merged and pushed branches are removable; a local-only commit is not; a live cwd protects', async () => {
    const { root, r } = repo()
    const commit = (wt: string, file: string) => { writeFileSync(join(wt, file), file); g(wt, 'add', '.'); g(wt, 'commit', '-qm', file) }
    // squash: same patch lands on main under another sha
    g(r, 'worktree', 'add', '-q', join(root, 'squash'), '-b', 'squash'); commit(join(root, 'squash'), 's')
    writeFileSync(join(r, 'm'), 'm'); g(r, 'add', '.'); g(r, 'commit', '-qm', 'diverge')
    g(r, 'cherry-pick', g(join(root, 'squash'), 'rev-parse', 'HEAD').trim())
    // pushed: a bare remote holds the branch at the same commit
    const bare = join(root, 'bare.git'); g(root, 'init', '-q', '--bare', bare); g(r, 'remote', 'add', 'origin', bare)
    g(r, 'worktree', 'add', '-q', join(root, 'pushed'), '-b', 'pushed'); commit(join(root, 'pushed'), 'p')
    g(join(root, 'pushed'), 'push', '-q', 'origin', 'pushed')
    // local only
    g(r, 'worktree', 'add', '-q', join(root, 'local'), '-b', 'local'); commit(join(root, 'local'), 'l')
    const facts = await worktreeFacts(r, { env })
    const by = (p: string) => facts.find(f => f.path === join(root, p))!
    expect(by('squash')).toMatchObject({ merged: false, squashed: true })
    expect(by('pushed')).toMatchObject({ merged: false, pushed: true })
    expect(by('local')).toMatchObject({ pushed: false, squashed: false })
    const kinds = Object.fromEntries(planClean(facts, Date.now()).map(i => [i.facts.path.split('/').pop(), i.action.kind]))
    expect(kinds).toMatchObject({ squash: 'remove', pushed: 'remove', local: 'keep' })
    expect(cwdInside(join(root, 'x'), [join(root, 'x', 'sub')])).toBe(true)
    expect(cwdInside(join(root, 'x'), [join(root, 'xy')])).toBe(false)
  })

  test('a stopped but not-ended managed session keeps its worktree in use', async () => {
    const { root, r } = repo()
    expect(openSessionCwds([{ cwd: '/a' }, { cwd: '/b', endedAt: '2026-01-01T00:00:00Z' }, { cwd: '' }])).toEqual(['/a'])
    const facts = await worktreeFacts(r, { env, managedCwds: openSessionCwds([{ cwd: join(root, 'merged') }, { cwd: join(root, 'dirty'), endedAt: 'x' }]) })
    const by = (p: string) => facts.find(f => f.path === join(root, p))!
    expect(by('merged').inUse).toBe(true)
    expect(by('dirty').inUse).toBe(false)
    expect(planClean(facts, Date.now()).find(i => i.facts.path === join(root, 'merged'))!.action).toEqual({ kind: 'keep', reason: 'active' })
  })

  const seamEnv = { env, managedCwds: [] as string[], processCwds: () => ({ cwds: [] as string[], known: true }) }
  const pushedWorktree = () => {
    const { root, r } = repo()
    const bare = join(root, 'bare.git'); g(root, 'init', '-q', '--bare', bare); g(r, 'remote', 'add', 'origin', bare)
    g(r, 'worktree', 'add', '-q', join(root, 'pw'), '-b', 'pw')
    const wt = join(root, 'pw'); writeFileSync(join(wt, 'c'), 'c'); g(wt, 'add', '.'); g(wt, 'commit', '-qm', 'c'); g(wt, 'push', '-q', 'origin', 'pw')
    return { root, r, wt }
  }

  test('an ignored file that cannot be regenerated keeps a pushed worktree, in the plan and in the apply', async () => {
    const { r, wt } = pushedWorktree()
    writeFileSync(join(wt, '.gitignore'), '.env.local\n*.secret\ndist\n'); g(wt, 'add', '.'); g(wt, 'commit', '-qm', 'ign'); g(wt, 'push', '-q', 'origin', 'pw')
    mkdirSync(join(wt, 'dist')); writeFileSync(join(wt, 'dist', 'x'), 'x')
    // only regenerable ignored output: removable
    let facts = await worktreeFacts(r, seamEnv)
    expect(facts.find(f => f.path === wt)).toMatchObject({ pushed: true, dirty: false })
    expect(facts.find(f => f.path === wt)!.keepsIgnored).toBeUndefined()
    expect(planClean(facts, Date.now()).find(i => i.facts.path === wt)!.action.kind).toBe('remove')
    const staleRemovable = planClean(facts, Date.now())
    // a secret appears AFTER the plan: the apply must notice and refuse
    writeFileSync(join(wt, 'creds.secret'), 's')
    const problems = await applyClean(staleRemovable, seamEnv)
    expect(problems.join('\n')).toContain('ignored files that cannot be regenerated')
    expect(existsSync(join(wt, 'creds.secret'))).toBe(true)
    // and a fresh plan keeps it with the stated reason
    facts = await worktreeFacts(r, seamEnv)
    expect(planClean(facts, Date.now()).find(i => i.facts.path === wt)!.action).toEqual({ kind: 'keep', reason: 'ignored' })
    writeFileSync(join(wt, '.env.local'), 'k')
    expect(existsSync(join(wt, '.env.local'))).toBe(true)
  })

  test('isRegenerable only forgives the known rebuildable outputs', () => {
    for (const p of ['node_modules/', 'dist/', 'packages/a/build/', '.turbo/', '.next/', 'coverage/', '.cache/', 'tsconfig.tsbuildinfo', 'out/']) expect(isRegenerable(p)).toBe(true)
    for (const p of ['.env.local', 'creds.secret', 'secrets/', '"odd name"']) expect(isRegenerable(p)).toBe(false)
  })

  test('an unreadable or corrupt session registry is UNKNOWN: nothing is removed and a warning is raised', async () => {
    const { root, r, wt } = pushedWorktree()
    const reg = join(root, 'managed-sessions.json')
    const run = async (text: string | null) => {
      if (text !== null) writeFileSync(reg, text)
      const warnings: string[] = []
      const facts = await worktreeFacts(r, { env, registryFile: reg, processCwds: () => ({ cwds: [], known: true }), onWarning: m => warnings.push(m) })
      return { f: facts.find(x => x.path === wt)!, warnings, plan: planClean(facts, Date.now()).find(i => i.facts.path === wt)!.action }
    }
    const corrupt = await run('{not json')
    expect(corrupt.f.useUnknown).toBe(true)
    expect(corrupt.plan).toEqual({ kind: 'keep', reason: 'unknown-use' })
    expect(corrupt.warnings.length).toBe(1)
    expect((await run('{"a":1}')).plan).toEqual({ kind: 'keep', reason: 'unknown-use' })
    // an absent registry file is a real empty one; a well-formed one naming the cwd protects it
    rmSync(reg)
    expect((await run(null)).plan.kind).toBe('remove')
    expect((await run(JSON.stringify([{ cwd: wt }]))).plan).toEqual({ kind: 'keep', reason: 'active' })
    expect((await run(JSON.stringify([{ cwd: wt, endedAt: 'x' }]))).plan.kind).toBe('remove')
  })

  test('a process reader that cannot answer is unknown, not "not in use"', async () => {
    const { r, wt } = pushedWorktree()
    const facts = await worktreeFacts(r, { env, managedCwds: [], processCwds: () => ({ cwds: [], known: false }) })
    expect(planClean(facts, Date.now()).find(i => i.facts.path === wt)!.action).toEqual({ kind: 'keep', reason: 'unknown-use' })
  })

  test('the apply re-checks use and dirtiness right before each removal', async () => {
    const { r, wt } = pushedWorktree()
    const plan = planClean(await worktreeFacts(r, seamEnv), Date.now()).filter(i => i.facts.path === wt)
    expect(plan[0]!.action.kind).toBe('remove')
    // a process moves in after the plan
    let problems = await applyClean(plan, { ...seamEnv, processCwds: () => ({ cwds: [join(wt, 'sub')], known: true }) })
    expect(problems.join('\n')).toContain('in use now'); expect(existsSync(wt)).toBe(true)
    // the registry becomes unreadable after the plan
    problems = await applyClean(plan, { env, registryFile: join(wt, 'c', 'x'), processCwds: () => ({ cwds: [], known: true }) })
    expect(problems.join('\n')).toContain('unknown whether it is in use'); expect(existsSync(wt)).toBe(true)
    // uncommitted work appears after the plan
    writeFileSync(join(wt, 'late'), 'x')
    problems = await applyClean(plan, seamEnv)
    expect(problems.join('\n')).toContain('uncommitted changes now'); expect(existsSync(join(wt, 'late'))).toBe(true)
    // nothing changed: it goes
    rmSync(join(wt, 'late'))
    expect(await applyClean(plan, seamEnv)).toEqual([]); expect(existsSync(wt)).toBe(false)
  })

  test('a child that leaves stdout open cannot strand clean after the timeout', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'clean-timeout-'))); dirs.push(root)
    const fakeBin = join(root, 'git')
    writeFileSync(fakeBin, '#!/bin/sh\nsleep 10\n')
    chmodSync(fakeBin, 0o755)
    const target = join(root, 'repo'); mkdirSync(target)
    const started = Date.now()
    expect(await repoOf(target, { env: { ...env, PATH: root }, timeoutMs: 25 })).toBeNull()
    expect(Date.now() - started).toBeLessThan(1000)
  })
})


describe('live scan callbacks and cancellation', () => {
  test('emits one start and completed fact per worktree without changing the plan', async () => {
    const { r } = repo()
    const started: string[] = [], completed: string[] = []
    let total = 0
    const facts = await worktreeFacts(r, { env, onDiscover: count => { total = count }, onItemStart: path => started.push(path), onItem: fact => completed.push(fact.path) })
    expect(total).toBe(facts.length)
    expect([...started].sort()).toEqual(facts.map(f => f.path).sort())
    expect([...completed].sort()).toEqual([...started].sort())
  })
  test('a pre-cancelled scan starts no process and emits no completed item', async () => {
    const controller = new AbortController(); controller.abort()
    const completed: string[] = []
    await expect(worktreeFacts('/does-not-exist', { env, signal: controller.signal, onItem: f => completed.push(f.path) })).rejects.toThrow()
    expect(completed).toEqual([])
  })
  test('cancellation interrupts a process even when its child holds stdout open', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'clean-abort-'))); dirs.push(root)
    const fakeBin = join(root, 'git'); writeFileSync(fakeBin, '#!/bin/sh\nsleep 10\n'); chmodSync(fakeBin, 0o755)
    const target = join(root, 'repo'); mkdirSync(target)
    const controller = new AbortController()
    const task = repoOf(target, { env: { ...env, PATH: `${root}:/usr/bin:/bin` }, signal: controller.signal })
    const started = Date.now()
    const timeout = setTimeout(() => controller.abort(), 25)
    try { await expect(task).rejects.toThrow(); expect(Date.now() - started).toBeLessThan(1000) }
    finally { clearTimeout(timeout) }
  })
  test.skipIf(process.platform !== 'linux')('newest nested mtime wins over the commit without another walk', async () => {
    const { root, r } = repo()
    const nested = join(root, 'wip', 'node_modules', 'x', 'f')
    const future = new Date(Date.now() + 86_400_000)
    utimesSync(nested, future, future)
    const facts = await worktreeFacts(r, { env })
    const wip = facts.find(f => f.path === join(root, 'wip'))!
    expect(wip.lastActivityMs!).toBeGreaterThanOrEqual(Math.floor(future.getTime() / 1000) * 1000)
    expect(wip.lastActivityMs!).toBeGreaterThan(wip.lastCommitMs!)
  })
})

describe('sizes are measured, never a silent 0 (LIMPEZA.ZERO)', () => {
  test('parseDu reads the total and the node_modules line of one walk', () => {
    expect(parseDu('40\t1700000001\t/w/node_modules\n4\t1700000000\t/w/src\n100\t1700000002\t/w\n', '/w', true))
      .toEqual({ bytes: 102400, mtimeMs: 1700000002000, nodeModulesBytes: 40960 })
    expect(parseDu('100\t/w\n', '/w', false)).toEqual({ bytes: 102400, mtimeMs: null, nodeModulesBytes: 0 })
    expect(parseDu('', '/w', true)).toBeNull()
    expect(parseDu('du: cannot read', '/w', true)).toBeNull()
  })
  test('real sizes are non-zero, and the main checkout does not count worktrees nested inside it', async () => {
    const { root, r } = repo()
    const nested = join(r, '.claude', 'worktrees', 'big')
    g(r, 'worktree', 'add', '-q', nested, '-b', 'big')
    writeFileSync(join(nested, 'blob'), 'x'.repeat(2_000_000))
    const facts = await worktreeFacts(r, { env })
    const main = facts.find(f => f.isMain)!, big = facts.find(f => f.path === nested)!
    expect(big.sizeBytes).toBeGreaterThan(1_900_000)
    expect(main.sizeBytes).toBeGreaterThan(0)
    expect(main.sizeBytes).toBeLessThan(1_000_000)
    for (const f of facts.filter(f => !f.missing)) { expect(f.sizeBytes).toBeGreaterThan(0); expect(f.sizeUnknown).toBeUndefined() }
    expect(facts.find(f => f.path === join(root, 'wip'))!.nodeModulesBytes).toBeGreaterThan(0)
  })
  test('a du that cannot answer marks the size unknown instead of measuring 0', async () => {
    const { r } = repo()
    const bin = realpathSync(mkdtempSync(join(tmpdir(), 'clean-du-'))); dirs.push(bin)
    writeFileSync(join(bin, 'du'), '#!/bin/sh\nexit 1\n'); chmodSync(join(bin, 'du'), 0o755)
    const facts = await worktreeFacts(r, { env: { ...env, PATH: `${bin}:${env.PATH ?? '/usr/bin:/bin'}` } })
    for (const f of facts) expect(f.sizeUnknown).toBe(true)
  })
})
