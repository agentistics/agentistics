import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { configFingerprint, createFingerprintMemo, findGitDirs, headFingerprint } from './git-fs'
import { clearGitStatsCache, getGitRemote, gitMetaSpawnCount } from './git'
import { gitTestEnv } from '@agentistics/core/gitTestEnv'

const ID = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' }
const g = (cwd: string, ...a: string[]) => execFileSync('git', ['-C', cwd, ...a], { env: { ...gitTestEnv(), ...ID }, stdio: 'pipe' }).toString().trim()

let root = '', repo = '', wt = ''
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'git-fs-'))
  repo = join(root, 'repo'); mkdirSync(repo)
  g(repo, 'init', '-q', '-b', 'main')
  writeFileSync(join(repo, 'a'), '1'); g(repo, 'add', 'a'); g(repo, 'commit', '-qm', 'one')
  g(repo, 'remote', 'add', 'origin', 'https://github.com/o/r.git')
  wt = join(root, 'wt')
  g(repo, 'worktree', 'add', '-q', '-b', 'side', wt)
})
afterAll(() => rmSync(root, { recursive: true, force: true }))

describe('findGitDirs', () => {
  test('a main checkout, from a subdirectory too', async () => {
    mkdirSync(join(repo, 'sub'), { recursive: true })
    const d = await findGitDirs(join(repo, 'sub'))
    expect(d?.gitDir).toBe(join(repo, '.git'))
    expect(d?.commonDir).toBe(join(repo, '.git'))
  })
  test('a linked worktree resolves its own git dir and the common one', async () => {
    const d = await findGitDirs(wt)
    expect(d?.gitDir).toBe(join(repo, '.git', 'worktrees', 'wt'))
    expect(d?.commonDir).toBe(join(repo, '.git'))
  })
  test('outside any repository: null', async () => {
    expect(await findGitDirs(tmpdir())).toBeNull()
  })
})

describe('headFingerprint', () => {
  test('changes exactly when HEAD moves — a commit, a branch switch, a pack', async () => {
    const d = (await findGitDirs(repo))!
    const a = await headFingerprint(d)
    expect(a).not.toBeNull()
    expect(await headFingerprint(d)).toBe(a)
    writeFileSync(join(repo, 'a'), '2'); g(repo, 'commit', '-qam', 'two')
    const b = await headFingerprint(d)
    expect(b).not.toBe(a)
    g(repo, 'pack-refs', '--all')
    const c = await headFingerprint(d)
    expect(c).not.toBe(b)
    g(repo, 'checkout', '-q', '--detach')
    expect(await headFingerprint(d)).toBe(`detached ${g(repo, 'rev-parse', 'HEAD')}`)
    g(repo, 'checkout', '-q', 'main')
  })
  test('a commit in a worktree changes the worktree fingerprint, not the main one', async () => {
    const dm = (await findGitDirs(repo))!, dw = (await findGitDirs(wt))!
    const m0 = await headFingerprint(dm), w0 = await headFingerprint(dw)
    writeFileSync(join(wt, 'b'), 'x'); g(wt, 'add', 'b'); g(wt, 'commit', '-qm', 'wt')
    expect(await headFingerprint(dw)).not.toBe(w0)
    expect(await headFingerprint(dm)).toBe(m0)
  })
})

describe('configFingerprint', () => {
  test('changes when the remote changes, and refuses a config with an include', async () => {
    const d = (await findGitDirs(repo))!
    const a = await configFingerprint(d)
    g(repo, 'remote', 'set-url', 'origin', 'https://github.com/o/other.git')
    expect(await configFingerprint(d)).not.toBe(a)
    g(repo, 'config', 'include.path', '/nowhere')
    expect(await configFingerprint(d)).toBeNull()
    g(repo, 'config', '--unset', 'include.path')
  })
})

describe('getGitRemote — spawns only when the config changed', () => {
  test('a second read of an unchanged repo costs no process, a set-url is seen at once', async () => {
    clearGitStatsCache()
    g(repo, 'remote', 'set-url', 'origin', 'https://github.com/o/r.git')
    const n0 = gitMetaSpawnCount()
    expect(await getGitRemote(repo)).toBe('github.com/o/r')
    expect(await getGitRemote(repo)).toBe('github.com/o/r')
    expect(gitMetaSpawnCount() - n0).toBe(1)
    g(repo, 'remote', 'set-url', 'origin', 'https://github.com/o/new.git')
    expect(await getGitRemote(repo)).toBe('github.com/o/new')
    expect(gitMetaSpawnCount() - n0).toBe(2)
  })
  test('not a repository: no process at all', async () => {
    const n0 = gitMetaSpawnCount()
    expect(await getGitRemote(join(root))).toBeUndefined()
    expect(gitMetaSpawnCount() - n0).toBe(0)
  })
})

test('createFingerprintMemo: a null fingerprint never hits and is never stored', () => {
  const m = createFingerprintMemo<number>()
  m.set('k', null, 1)
  expect(m.get('k', null).hit).toBe(false)
  m.set('k', 'a', 2)
  expect(m.get('k', 'a')).toEqual({ hit: true, value: 2 })
  expect(m.get('k', 'b').hit).toBe(false)
})
