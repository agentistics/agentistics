/**
 * Integration: a throwaway repository with a bare "origin" and fake worktrees. Only the right ones go.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gitTestEnv } from '@agentistics/core/gitTestEnv'
import { applyClean, cleanAfterHandback, worktreeFacts, type CleanIoOpts, type HandoffDeps } from './clean-io'
import { planClean } from './clean-plan'

const author = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', GIT_CONFIG_GLOBAL: '/dev/null' }
const env = { ...gitTestEnv(), ...author }
let root: string, repo: string
const wt = (name: string) => join(root, 'wt', name)
const git = (cwd: string, ...args: string[]) => {
  const r = Bun.spawnSync(['git', '-C', cwd, ...args], { env: { ...gitTestEnv(), ...author } })
  if (r.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`)
  return r.stdout.toString().trim()
}
const commit = (cwd: string, file: string, text = file) => { writeFileSync(join(cwd, file), text); git(cwd, 'add', file); git(cwd, 'commit', '-qm', file) }
const worktree = (name: string) => { git(repo, 'worktree', 'add', '-qb', name, wt(name), 'main'); return wt(name) }

const heads = new Map<string, string>()
let io: CleanIoOpts

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'handoff-clean-'))
  const origin = join(root, 'origin.git')
  repo = join(root, 'repo')
  mkdirSync(origin); mkdirSync(repo)
  git(origin, 'init', '-q', '--bare', '-b', 'main')
  git(repo, 'init', '-q', '-b', 'main')
  writeFileSync(join(repo, '.gitignore'), '.env\nnode_modules/\n')
  git(repo, 'add', '.gitignore'); git(repo, 'commit', '-qm', 'base')
  git(repo, 'remote', 'add', 'origin', origin)
  git(repo, 'push', '-q', 'origin', 'main')

  // merged: pushed, then merged into main with a merge commit.
  commit(worktree('merged'), 'a.txt'); git(wt('merged'), 'push', '-q', 'origin', 'merged')
  git(repo, 'merge', '-q', '--no-ff', '-m', 'm', 'merged'); git(repo, 'push', '-q', 'origin', 'main')

  // squashed-pr: TWO commits squashed into one on main (git cherry cannot see it); branch gone from origin.
  const sq = worktree('squashed-pr'); commit(sq, 's1.txt'); commit(sq, 's2.txt')
  heads.set('squashed-pr', git(sq, 'rev-parse', 'HEAD'))
  git(repo, 'merge', '-q', '--squash', 'squashed-pr'); git(repo, 'commit', '-qm', 'squash'); git(repo, 'push', '-q', 'origin', 'main')

  // later: its PR was merged, then one more commit was made. Not published by that PR.
  const later = worktree('later'); commit(later, 'l1.txt'); heads.set('later', git(later, 'rev-parse', 'HEAD')); commit(later, 'l2.txt')

  for (const name of ['dirty', 'inuse', 'young', 'ignored']) {
    commit(worktree(name), `${name}.txt`); git(wt(name), 'push', '-q', 'origin', name)
    if (name !== 'young') { git(repo, 'merge', '-q', '--no-ff', '-m', name, name); git(repo, 'push', '-q', 'origin', 'main') }
  }
  writeFileSync(join(wt('dirty'), 'new.txt'), 'x')
  writeFileSync(join(wt('ignored'), '.env'), 'SECRET=1')

  io = {
    env,
    processCwds: () => ({ cwds: [wt('inuse')], known: true }),
    managedCwds: [],
    mergedPrs: async () => [...heads].map(([branch, oid]) => ({ branch, oid })),
    patchDir: join(root, 'patches'),
    cleanup: { health: async () => ({ level: 'ok', dirtyWriteback: 0 }), heavyBusy: async () => false, sleep: async () => {}, lockPath: join(root, 'lock') },
  }
})
afterAll(() => { rmSync(root, { recursive: true, force: true }) })

// A throwaway lock per removal: the real hourly rate limit lives beside the lock file.
let locks = 0
const own = (): CleanIoOpts => ({ ...io, cleanup: { ...io.cleanup, lockPath: join(root, `lock-${++locks}`) } })
const deps = (handedBack = true): HandoffDeps => ({ handedBack: async () => handedBack, io: own() })
const close = (name: string, d = deps()) => cleanAfterHandback({ id: 's1', cwd: wt(name) }, d)

describe('cleanup after a handback', () => {
  test('keeps what is dirty, in use, not merged, holding an ignored secret, or only partly merged', async () => {
    for (const name of ['dirty', 'inuse', 'young', 'ignored', 'later']) {
      expect((await close(name)).removed).toBe(false)
      expect(existsSync(wt(name))).toBe(true)
    }
  })
  test('does nothing without a handback, and never touches the main checkout or a subdirectory', async () => {
    expect((await close('merged', deps(false))).removed).toBe(false)
    expect((await cleanAfterHandback({ id: 's1', cwd: repo }, deps())).removed).toBe(false)
    mkdirSync(join(wt('merged'), 'sub'), { recursive: true })
    expect((await cleanAfterHandback({ id: 's1', cwd: join(wt('merged'), 'sub') }, deps())).removed).toBe(false)
    rmSync(join(wt('merged'), 'sub'), { recursive: true })
    expect(existsSync(wt('merged'))).toBe(true)
  })
  test('removes a merged worktree and one whose multi-commit PR was squash-merged', async () => {
    expect((await close('merged')).removed).toBe(true)
    expect((await close('squashed-pr')).removed).toBe(true)
    expect(existsSync(wt('merged'))).toBe(false)
    expect(existsSync(wt('squashed-pr'))).toBe(false)
    expect(git(repo, 'branch', '--list', 'merged')).toContain('merged')
  })
})

describe('a session that takes the directory while it is being removed', () => {
  /** A merged worktree with an ignored node_modules, so there is a moment between the checks and the removal. */
  const merged = (name: string) => {
    const path = worktree(name); commit(path, `${name}.txt`); git(path, 'push', '-q', 'origin', name)
    git(repo, 'merge', '-q', '--no-ff', '-m', name, name); git(repo, 'push', '-q', 'origin', 'main')
    mkdirSync(join(path, 'node_modules')); writeFileSync(join(path, 'node_modules', 'dep'), 'x')
    return path
  }
  const cases: Array<[string, (path: string) => { rows?: object[]; cwds?: string[] }, boolean]> = [
    ['a live process', path => ({ cwds: [path] }), true],
    ['a session just starting', path => ({ rows: [{ id: 'new', cwd: path, createdAt: new Date().toISOString() }] }), true],
    ['a stopped session never ended', path => ({ rows: [{ id: 'idle', cwd: path, lastSeenMs: 1 }] }), true],
    ['only an ended session', path => ({ rows: [{ id: 'old', cwd: path, endedAt: '2026-01-01T00:00:00Z' }] }), false],
  ]
  for (const [i, [name, arrive, keeps]] of cases.entries()) {
    test(`${name} ${keeps ? 'keeps' : 'does not keep'} the worktree`, async () => {
      const path = merged(`race-${i}`)
      const registryFile = join(root, `registry-${i}.json`)
      let cwds: string[] = []
      let arrived = false
      const base = own()
      const { managedCwds: _seam, ...rest } = base
      const result = await cleanAfterHandback({ id: 's1', cwd: path }, {
        handedBack: async () => true,
        io: {
          ...rest, registryFile, processCwds: () => ({ cwds, known: true }),
          cleanup: { ...base.cleanup, onBatch: () => {
            const now = arrive(path)
            if (now.rows) writeFileSync(registryFile, JSON.stringify(now.rows))
            cwds = now.cwds ?? []
            arrived = true
          } },
        },
      })
      expect(arrived).toBe(true)
      expect(result.removed).toBe(!keeps)
      expect(existsSync(path)).toBe(keeps)
    })
  }
})

describe('a refusal at the last check deletes nothing', () => {
  test('a session that arrives after the patch step keeps node_modules and the worktree', async () => {
    const path = worktree('refused'); commit(path, 'r.txt'); git(path, 'push', '-q', 'origin', 'refused')
    git(repo, 'merge', '-q', '--no-ff', '-m', 'refused', 'refused'); git(repo, 'push', '-q', 'origin', 'main')
    mkdirSync(join(path, 'node_modules')); writeFileSync(join(path, 'node_modules', 'dep'), 'x')
    let cwds: string[] = []
    let waits = 0
    const base = own()
    const result = await cleanAfterHandback({ id: 's1', cwd: path }, {
      handedBack: async () => true,
      io: {
        ...base, processCwds: () => ({ cwds, known: true }),
        // The second heavy-job look is the last wait before anything is deleted.
        cleanup: { ...base.cleanup, heavyBusy: async () => { if (++waits === 2) cwds = [path]; return false } },
      },
    })
    expect(waits).toBeGreaterThanOrEqual(2)
    expect(result.removed).toBe(false)
    expect(existsSync(join(path, 'node_modules', 'dep'))).toBe(true)
  })
})

describe('the age floor over real worktrees', () => {
  test('a freshly merged worktree is kept by the plan, and goes once its owner ended for good', async () => {
    const path = worktree('fresh'); commit(path, 'f.txt'); git(path, 'push', '-q', 'origin', 'fresh')
    git(repo, 'merge', '-q', '--no-ff', '-m', 'fresh', 'fresh'); git(repo, 'push', '-q', 'origin', 'main')
    const registryFile = join(root, 'registry-fresh.json')
    const { managedCwds: _seam, ...rest } = own()
    const action = async () => planClean(await worktreeFacts(repo, { ...rest, registryFile, only: path }), Date.now())[0]!.action
    writeFileSync(registryFile, '[]')
    expect(await action()).toEqual({ kind: 'keep', reason: 'young' })
    writeFileSync(registryFile, JSON.stringify([{ id: 'o', cwd: path, endedAt: '2026-11-28T00:00:00Z', endReason: 'account-switch' }]))
    expect(await action()).toEqual({ kind: 'keep', reason: 'young' })
    writeFileSync(registryFile, JSON.stringify([{ id: 'o', cwd: path, endedAt: '2026-11-28T00:00:00Z', endReason: 'final' }]))
    expect((await action()).kind).toBe('remove')
  })
})

describe('the manual plan over the same repository', () => {
  test('a clean pushed unmerged worktree goes only after 30 days, and its patch is saved first', async () => {
    const facts = await worktreeFacts(repo, io)
    const young = (now: number) => planClean(facts, now).find(i => i.facts.path === wt('young'))!
    expect(young(Date.now()).action.kind).toBe('keep')
    const stale = young(Date.now() + 31 * 86_400_000)
    expect(stale.action).toMatchObject({ kind: 'remove', savePatch: true })
    expect(await applyClean([stale], own())).toEqual([])
    expect(existsSync(wt('young'))).toBe(false)
    const dir = join(root, 'patches', 'repo')
    const saved = readdirSync(dir)
    expect(saved[0]).toStartWith('young-')
    expect(readdirSync(join(dir, saved[0]!)).filter(f => f.endsWith('.patch')).length).toBe(1)
  })

  test('a patch that cannot be saved keeps the worktree', async () => {
    commit(worktree('stuck'), 'k.txt'); git(wt('stuck'), 'push', '-q', 'origin', 'stuck')
    writeFileSync(join(root, 'not-a-dir'), '')
    const facts = await worktreeFacts(repo, io)
    const item = planClean(facts, Date.now() + 31 * 86_400_000).find(i => i.facts.path === wt('stuck'))!
    const problems = await applyClean([item], { ...own(), patchDir: join(root, 'not-a-dir') })
    expect(problems[0]).toContain('patch')
    expect(existsSync(wt('stuck'))).toBe(true)
  })
})
