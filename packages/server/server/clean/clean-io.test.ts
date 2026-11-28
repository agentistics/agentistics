import { afterEach, describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gitTestEnv } from '@agentistics/core/gitTestEnv'
import { applyClean as realApplyClean, withCleanupLock, cwdInside, isRegenerable, openSessionCwds, parseDu, repoOf, worktreeFacts, WORKTREE_POOL_SIZE } from './clean-io'
import { planClean } from './clean-plan'

const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })
const env = gitTestEnv()
/** The commits here are seconds old; plan as of past the 3-day age floor. */
const later = () => Date.now() + 4 * 86_400_000
const g = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, env: gitTestEnv(), encoding: 'utf8' })
const applyClean: typeof realApplyClean = (items, o = {}) => {
  let time = Date.now()
  return realApplyClean(items, { ...o, cleanup: {
    lockPath: join(dirs[0]!, 'cleanup.lock'), health: async () => ({ level: 'ok', dirtyWriteback: 0 }),
    heavyBusy: async () => false, now: () => time, sleep: async ms => { time += ms }, ...o.cleanup,
  } })
}

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
  const bare = join(root, 'initial.git'); g(root, 'init', '-q', '--bare', bare); g(r, 'remote', 'add', 'origin', bare)
  g(r, 'push', '-q', 'origin', 'done')
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

  test('only pushed branches are removable; local squash-merges and local commits are kept; a live cwd protects', async () => {
    const { root, r } = repo()
    const commit = (wt: string, file: string) => { writeFileSync(join(wt, file), file); g(wt, 'add', '.'); g(wt, 'commit', '-qm', file) }
    // squash: same patch lands on main under another sha
    g(r, 'worktree', 'add', '-q', join(root, 'squash'), '-b', 'squash'); commit(join(root, 'squash'), 's')
    writeFileSync(join(r, 'm'), 'm'); g(r, 'add', '.'); g(r, 'commit', '-qm', 'diverge')
    g(r, 'cherry-pick', g(join(root, 'squash'), 'rev-parse', 'HEAD').trim())
    // pushed: a bare remote holds the branch at the same commit
    const bare = join(root, 'bare.git'); g(root, 'init', '-q', '--bare', bare); g(r, 'remote', 'set-url', 'origin', bare)
    g(r, 'worktree', 'add', '-q', join(root, 'pushed'), '-b', 'pushed'); commit(join(root, 'pushed'), 'p')
    g(join(root, 'pushed'), 'push', '-q', 'origin', 'pushed')
    // local only
    g(r, 'worktree', 'add', '-q', join(root, 'local'), '-b', 'local'); commit(join(root, 'local'), 'l')
    const facts = await worktreeFacts(r, { env })
    const by = (p: string) => facts.find(f => f.path === join(root, p))!
    expect(by('squash')).toMatchObject({ merged: false, squashed: true })
    expect(by('pushed')).toMatchObject({ merged: false, pushed: true })
    expect(by('local')).toMatchObject({ pushed: false, squashed: false })
    const kinds = Object.fromEntries(planClean(facts, later()).map(i => [i.facts.path.split('/').pop(), i.action.kind]))
    // Pushed but not merged is not "done": a recent one stays (it goes only after 30 days, patch first).
    expect(kinds).toMatchObject({ squash: 'keep', pushed: 'keep', local: 'keep' })
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
    expect(planClean(facts, later()).find(i => i.facts.path === join(root, 'merged'))!.action).toEqual({ kind: 'keep', reason: 'active' })
  })

  const seamEnv = { env, managedCwds: [] as string[], processCwds: () => ({ cwds: [] as string[], known: true }) }
  const pushedWorktree = () => {
    const { root, r } = repo()
    const bare = join(root, 'bare.git'); g(root, 'init', '-q', '--bare', bare); g(r, 'remote', 'set-url', 'origin', bare)
    g(r, 'worktree', 'add', '-q', join(root, 'pw'), '-b', 'pw')
    const wt = join(root, 'pw'); writeFileSync(join(wt, 'c'), 'c'); g(wt, 'add', '.'); g(wt, 'commit', '-qm', 'c'); g(wt, 'push', '-q', 'origin', 'pw')
    mergeIn(r)
    return { root, r, wt }
  }
  /** Merge pw into main and publish it, so the worktree counts as done. */
  const mergeIn = (r: string) => { g(r, 'merge', '-q', '--no-edit', 'pw'); g(r, 'push', '-q', 'origin', 'main') }

  test('an ignored file that cannot be regenerated keeps a pushed worktree, in the plan and in the apply', async () => {
    const { r, wt } = pushedWorktree()
    writeFileSync(join(wt, '.gitignore'), '.env.local\n*.secret\ndist\n'); g(wt, 'add', '.'); g(wt, 'commit', '-qm', 'ign'); g(wt, 'push', '-q', 'origin', 'pw')
    mergeIn(r)
    mkdirSync(join(wt, 'dist')); writeFileSync(join(wt, 'dist', 'x'), 'x')
    // only regenerable ignored output: removable
    let facts = await worktreeFacts(r, seamEnv)
    expect(facts.find(f => f.path === wt)).toMatchObject({ pushed: true, dirty: false })
    expect(facts.find(f => f.path === wt)!.keepsIgnored).toBeUndefined()
    expect(planClean(facts, later()).find(i => i.facts.path === wt)!.action.kind).toBe('remove')
    const staleRemovable = planClean(facts, later())
    // a secret appears AFTER the plan: the apply must notice and refuse
    writeFileSync(join(wt, 'creds.secret'), 's')
    const problems = await applyClean(staleRemovable, seamEnv)
    expect(problems.join('\n')).toContain('ignored files that cannot be regenerated')
    expect(existsSync(join(wt, 'creds.secret'))).toBe(true)
    // and a fresh plan keeps it with the stated reason
    facts = await worktreeFacts(r, seamEnv)
    expect(planClean(facts, later()).find(i => i.facts.path === wt)!.action).toEqual({ kind: 'keep', reason: 'ignored' })
    writeFileSync(join(wt, '.env.local'), 'k')
    expect(existsSync(join(wt, '.env.local'))).toBe(true)
  })

  test('isRegenerable only forgives the known rebuildable outputs', () => {
    for (const p of ['node_modules/', 'dist/', 'packages/a/build/', '.turbo/', '.next/', 'coverage/', '.cache/', 'tsconfig.tsbuildinfo', 'out/']) expect(isRegenerable(p)).toBe(true)
    for (const p of ['.env.local', 'creds.secret', 'secrets/', '"odd name"', 'src/dist/keys.secret', 'app/out/creds.secret', 'dist/keys.secret', 'node_modules/x/y.secret']) expect(isRegenerable(p)).toBe(false)
  })

  test('a loose ignored file inside dist/ or out/ is kept, never removed with the worktree', async () => {
    const { root, r } = repo()
    const wt = join(root, 'secrets-wt')
    g(r, 'worktree', 'add', '-q', wt, '-b', 'secrets')
    mkdirSync(join(wt, 'src', 'dist'), { recursive: true }); mkdirSync(join(wt, 'app', 'out'), { recursive: true })
    writeFileSync(join(wt, '.gitignore'), '*.secret\n')
    writeFileSync(join(wt, 'src', 'dist', 'index.js'), '1')
    g(wt, 'add', '-f', '.gitignore', 'src/dist/index.js'); g(wt, 'commit', '-qm', 'tracked dist')
    writeFileSync(join(wt, 'src', 'dist', 'keys.secret'), 's'); writeFileSync(join(wt, 'app', 'out', 'creds.secret'), 's')
    const facts = await worktreeFacts(r, { env, processCwds: () => ({ cwds: [], known: true }), managedCwds: [] })
    const f = facts.find(x => x.path === wt)!
    expect(f.keepsIgnored).toBe(true)
    const problems = await applyClean([{ facts: f, action: { kind: 'remove' } } as never], { env, processCwds: () => ({ cwds: [], known: true }), managedCwds: [] })
    expect(problems.join('\n')).toContain('cannot be regenerated')
    expect(existsSync(join(wt, 'src', 'dist', 'keys.secret'))).toBe(true)
    expect(existsSync(join(wt, 'app', 'out', 'creds.secret'))).toBe(true)
  })

  test('an unreadable or corrupt session registry is UNKNOWN: nothing is removed and a warning is raised', async () => {
    const { root, r, wt } = pushedWorktree()
    const reg = join(root, 'managed-sessions.json')
    const run = async (text: string | null) => {
      if (text !== null) writeFileSync(reg, text)
      const warnings: string[] = []
      const facts = await worktreeFacts(r, { env, registryFile: reg, processCwds: () => ({ cwds: [], known: true }), onWarning: m => warnings.push(m) })
      return { f: facts.find(x => x.path === wt)!, warnings, plan: planClean(facts, later()).find(i => i.facts.path === wt)!.action }
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
    expect(planClean(facts, later()).find(i => i.facts.path === wt)!.action).toEqual({ kind: 'keep', reason: 'unknown-use' })
  })

  test('the apply re-checks use and dirtiness right before each removal', async () => {
    const { r, wt } = pushedWorktree()
    const plan = planClean(await worktreeFacts(r, seamEnv), later()).filter(i => i.facts.path === wt)
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

  test('applyClean uses throttledRemove batches and refuses dirty, unpushed and detached HEAD at apply time', async () => {
    const { r, wt } = pushedWorktree()
    const plan = planClean(await worktreeFacts(r, seamEnv), later()).filter(i => i.facts.path === wt)
    writeFileSync(join(wt, 'late'), 'not saved')
    expect((await applyClean(plan, seamEnv)).join()).toContain('uncommitted changes')
    g(wt, 'add', '.'); g(wt, 'commit', '-qm', 'local only')
    expect((await applyClean(plan, seamEnv)).join()).toContain('not committed and pushed')
    g(wt, 'push', '-q', 'origin', 'pw'); g(wt, 'checkout', '--detach', '-q')
    expect((await applyClean(plan, seamEnv)).join()).toContain('detached HEAD')
    expect(existsSync(wt)).toBe(true)
    g(wt, 'checkout', '-q', 'pw')
    writeFileSync(join(wt, '.gitignore'), 'node_modules\n'); g(wt, 'add', '.'); g(wt, 'commit', '-qm', 'ignore'); g(wt, 'push', '-q', 'origin', 'pw')
    mkdirSync(join(wt, 'node_modules'))
    for (let i = 0; i < 2100; i++) writeFileSync(join(wt, 'node_modules', `f${i}`), 'x')
    const batches: number[] = []
    expect(await applyClean(plan, { ...seamEnv, cleanup: { onBatch: n => batches.push(n) } })).toEqual([])
    expect(batches).toEqual([2000, 101]); expect(existsSync(wt)).toBe(false)
  })

  test('two cleanups serialize under the same kernel lock and release it after errors', async () => {
    const { root } = repo()
    const o = { env, cleanup: { lockPath: join(root, 'serialize.lock') } }
    const events: string[] = []
    let release!: () => void, entered!: () => void
    const inside = new Promise<void>(r => { entered = r })
    const gate = new Promise<void>(r => { release = r })
    const first = withCleanupLock(async () => { events.push('first'); entered(); await gate; events.push('released') }, o)
    await inside
    const pauses: string[] = []
    const second = withCleanupLock(async () => { events.push('second') }, { ...o, cleanup: { ...o.cleanup, onPause: reason => pauses.push(reason) } })
    await new Promise(r => setTimeout(r, 350))
    expect(events).toEqual(['first'])
    release(); await Promise.all([first, second])
    expect(pauses).toContain('waiting for cleanup lock')
    expect(events).toEqual(['first', 'released', 'second'])
    await expect(withCleanupLock(async () => { throw new Error('test failure') }, o)).rejects.toThrow('test failure')
    await withCleanupLock(async () => {}, o)
  })

  test.skipIf(process.platform !== 'linux')('SIGKILL of the cleaner releases its lock within one second', async () => {
    const { root } = repo()
    const lockPath = join(root, 'killed-cleaner.lock')
    const source = `import { withCleanupLock } from ${JSON.stringify(join(import.meta.dir, 'clean-io.ts'))};
      import { readFileSync } from 'node:fs';
      await withCleanupLock(async () => {
        console.log(readFileSync('/proc/' + process.pid + '/task/' + process.pid + '/children', 'utf8').trim());
        await new Promise(() => {});
      }, { cleanup: { lockPath: ${JSON.stringify(lockPath)} } });`
    const cleaner = Bun.spawn([process.execPath, '-e', source], { stdout: 'pipe', stderr: 'pipe' })
    const reader = cleaner.stdout.getReader()
    let holders: number[] = []
    try {
      const ready = await reader.read()
      expect(ready.done).toBe(false)
      holders = new TextDecoder().decode(ready.value).trim().split(/\s+/).map(Number)
      expect(holders.every(pid => pid > 0)).toBe(true)
      cleaner.kill('SIGKILL'); await cleaner.exited
      const started = Date.now()
      await withCleanupLock(async () => {}, { signal: AbortSignal.timeout(1000), cleanup: { lockPath } })
      expect(Date.now() - started).toBeLessThan(1000)
    } finally {
      cleaner.kill('SIGKILL'); await cleaner.exited
      // Only PIDs recorded as this cleaner's children; also clean up the pre-fix orphan.
      for (const pid of holders) { try { process.kill(pid, 'SIGKILL') } catch { /* already exited */ } }
      reader.releaseLock()
    }
  })

  test('a new unpushed commit during dependency removal prevents the final worktree removal', async () => {
    const { r, wt } = pushedWorktree()
    writeFileSync(join(wt, '.gitignore'), 'node_modules\n'); g(wt, 'add', '.'); g(wt, 'commit', '-qm', 'ignore'); g(wt, 'push', '-q', 'origin', 'pw')
    mergeIn(r)
    mkdirSync(join(wt, 'node_modules')); writeFileSync(join(wt, 'node_modules', 'dep'), 'x')
    const plan = planClean(await worktreeFacts(r, seamEnv), later()).filter(i => i.facts.path === wt)
    let committed = false
    const problems = await applyClean(plan, { ...seamEnv, cleanup: { onBatch: () => {
      expect(existsSync(join(wt, 'node_modules'))).toBe(false)
      writeFileSync(join(wt, 'late-commit'), 'keep me')
      g(wt, 'add', '.'); g(wt, 'commit', '-qm', 'late local commit')
      committed = true
    } } })
    expect(committed).toBe(true)
    expect(problems.join('\n')).toContain('not committed and pushed')
    expect(existsSync(join(wt, 'late-commit'))).toBe(true)
  })

  test('tight mid-tree leaves sources and remaining dependencies intact; symlinks never traverse outside', async () => {
    const { root, r, wt } = pushedWorktree()
    writeFileSync(join(wt, '.gitignore'), 'node_modules\n'); g(wt, 'add', '.'); g(wt, 'commit', '-qm', 'ignore'); g(wt, 'push', '-q', 'origin', 'pw')
    mergeIn(r)
    mkdirSync(join(wt, 'node_modules'))
    for (let i = 0; i < 2100; i++) writeFileSync(join(wt, 'node_modules', `f${i}`), 'x')
    const outside = join(root, 'outside'); mkdirSync(outside); writeFileSync(join(outside, 'saved'), 'keep')
    symlinkSync(outside, join(wt, 'node_modules', 'outside'))
    const plan = planClean(await worktreeFacts(r, seamEnv), later()).filter(i => i.facts.path === wt)
    const controller = new AbortController()
    let tight = false
    await expect(applyClean(plan, { ...seamEnv, signal: controller.signal, cleanup: {
      health: async () => ({ level: tight ? 'tight' : 'ok', dirtyWriteback: 0 }),
      onBatch: () => { tight = true }, onPause: () => { controller.abort() },
    } })).rejects.toThrow()
    expect(existsSync(join(wt, 'c'))).toBe(true)
    expect(existsSync(join(wt, 'node_modules'))).toBe(true)
    expect(existsSync(join(outside, 'saved'))).toBe(true)
    expect(await applyClean(plan, seamEnv)).toEqual([])
    expect(existsSync(wt)).toBe(false); expect(existsSync(join(outside, 'saved'))).toBe(true)
  })

  test('separate apply calls share rate reservations, and wait for a heavy holder before touching trees', async () => {
    const { root, r } = repo()
    const paths = ['one', 'two', 'three'].map(name => join(root, name))
    for (const path of paths) {
      const branch = path.split('/').at(-1)!
      g(r, 'worktree', 'add', '-q', path, '-b', branch); g(r, 'push', '-q', 'origin', branch)
    }
    const plan = planClean(await worktreeFacts(r, seamEnv), later()).filter(i => paths.includes(i.facts.path))
    let now = 0, busy = true
    const starts: number[] = [], reasons: string[] = []
    const cleanup = {
      lockPath: join(root, 'rate.lock'), now: () => now,
      health: async () => ({ level: 'ok' as const, dirtyWriteback: 0 }),
      heavyBusy: async () => busy, onPause: (reason: string) => reasons.push(reason),
      sleep: async (ms: number) => { expect(existsSync(paths[0]!)).toBe(starts.length === 0); now += ms; busy = false },
    }
    for (const item of plan) {
      expect(await applyClean([item], { ...seamEnv, cleanup })).toEqual([])
      starts.push(now)
    }
    expect(starts).toEqual([1000, 121000, 241000])
    expect(reasons).toContain('waiting for heavy jobs')
    expect(reasons).toContain('waiting for cleanup rate limit')
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
