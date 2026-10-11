import { afterEach, describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gitTestEnv } from '@agentistics/core/gitTestEnv'
import { applyClean, repoOf, worktreeFacts } from './clean-io'
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
