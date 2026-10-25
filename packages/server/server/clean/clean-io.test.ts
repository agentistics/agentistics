import { afterEach, describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gitTestEnv } from '@agentistics/core/gitTestEnv'
import { applyClean, parseDu, repoOf, worktreeFacts, WORKTREE_POOL_SIZE } from './clean-io'
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
