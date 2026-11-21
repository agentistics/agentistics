import { afterEach, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gitTestEnv } from '@agentistics/core/gitTestEnv'
import { proveInclusion } from './release-proof'
import { resetReleaseSquashForTest, squashPublishedIn } from '../sessions/release-squash'

const roots: string[] = []
afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true })
  resetReleaseSquashForTest()
})
function git(dir: string, ...args: string[]): string {
  if (!roots.includes(dir)) throw new Error('git fixture outside its temporary repository')
  return execFileSync('git', ['-C', dir, '-c', 'user.name=fixture', '-c', 'user.email=fixture@test',
    '-c', 'commit.gpgsign=false', '-c', 'tag.gpgsign=false', ...args], { env: gitTestEnv(), encoding: 'utf8' }).trim()
}
function commit(dir: string, files: Record<string, string>, message = 'fixture'): string {
  for (const [file, body] of Object.entries(files)) writeFileSync(join(dir, file), body)
  git(dir, 'add', '-A')
  git(dir, 'commit', '-qm', message)
  return git(dir, 'rev-parse', 'HEAD')
}
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'inclusion-'))
  roots.push(dir)
  git(dir, 'init', '-q', '-b', 'main')
  const base = commit(dir, { 'base.txt': 'base\n' })
  const repoKey = git(dir, 'rev-parse', '--path-format=absolute', '--git-common-dir')
  return { dir, repoKey, base }
}
function land(dir: string, branch: string, files: string[]): string {
  git(dir, 'checkout', '-q', 'main')
  git(dir, 'checkout', branch, '--', ...files)
  git(dir, 'commit', '-qm', 'squash onto main')
  return git(dir, 'rev-parse', 'HEAD')
}

test('§4.9.1 squash: patch-id names S while tag --contains A is empty', async () => {
  const f = fixture()
  git(f.dir, 'checkout', '-qb', 'piece')
  const a = commit(f.dir, { 'a.txt': 'piece\n' })
  const s = land(f.dir, 'piece', ['a.txt'])
  git(f.dir, 'tag', 'v1.0.0', s)
  expect(git(f.dir, 'tag', '--contains', a)).toBe('')
  expect(await proveInclusion({ ...f, pieceShas: [a], previous: f.base, target: s }))
    .toEqual({ kind: 'patch-id', containingCommit: s })
  expect(await squashPublishedIn(a, f.dir, f.repoKey)).toBe(true)
  git(f.dir, 'revert', '--no-edit', s)
  expect(await proveInclusion({ ...f, pieceShas: [a], previous: f.base, target: git(f.dir, 'rev-parse', 'HEAD') })).toBeNull()
})

test('§4.9.2 local range: declared P1 and undeclared P2 both have proofs without tags or remote', async () => {
  const f = fixture()
  git(f.dir, 'checkout', '-qb', 'p1')
  const p1 = commit(f.dir, { 'p1.txt': 'one\n' })
  const s1 = land(f.dir, 'p1', ['p1.txt'])
  git(f.dir, 'checkout', '-qb', 'p2')
  const p2 = commit(f.dir, { 'p2.txt': 'two\n' })
  const s2 = land(f.dir, 'p2', ['p2.txt'])
  expect(git(f.dir, 'tag')).toBe('')
  expect(git(f.dir, 'remote')).toBe('')
  for (const [piece, containingCommit] of [[p1, s1], [p2, s2]] as const) {
    expect(await proveInclusion({ ...f, pieceShas: [piece!], previous: f.base, target: s2 }))
      .toEqual({ kind: 'patch-id', containingCommit })
  }
  expect(await proveInclusion({ ...f, pieceShas: [p2], target: s2 }))
    .toEqual({ kind: 'patch-id', containingCommit: s2 })
})

test('§4.9.7 identical patch in unrelated repo B cannot prove a piece scoped to repo A', async () => {
  const a = fixture()
  git(a.dir, 'remote', 'add', 'origin', 'git@github.com:fixture/a.git')
  const piece = commit(a.dir, { 'same.txt': 'identical patch\n' })
  const b = fixture()
  git(b.dir, 'remote', 'add', 'origin', 'https://github.com/fixture/b.git')
  git(b.dir, 'fetch', '-q', a.dir, 'main')
  const target = commit(b.dir, { 'same.txt': 'identical patch\n' }, 'unrelated release')
  expect(await proveInclusion({ ...b, repoKey: 'github.com/fixture/b', pieceShas: [piece], target }))
    .not.toBeNull()
  expect(await proveInclusion({ ...b, repoKey: 'github.com/fixture/a', pieceShas: [piece], target })).toBeNull()
})

test('§4.9.8 multi-commit squash tree-holds requires the complete patch; later revert excludes it', async () => {
  const f = fixture()
  git(f.dir, 'checkout', '-qb', 'piece')
  const p1 = commit(f.dir, { 'a.txt': 'one\n' })
  const p2 = commit(f.dir, { 'b.txt': 'two\n' })
  git(f.dir, 'checkout', '-q', 'main')
  const partial = commit(f.dir, { 'a.txt': 'one\n', 'extra.txt': 'unrelated\n' })
  expect(await proveInclusion({ ...f, pieceShas: [p1, p2], target: partial })).toBeNull()
  git(f.dir, 'checkout', '-qb', 'release', f.base)
  const target = commit(f.dir, { 'a.txt': 'one\n', 'b.txt': 'two\n', 'extra.txt': 'unrelated\n' }, 'multi-commit squash plus other work')
  const input = { ...f, pieceShas: [p1, p2], previous: f.base }
  expect(await proveInclusion({ ...input, target })).toEqual({ kind: 'tree-holds', containingCommit: target })
  git(f.dir, 'revert', '--no-edit', target)
  expect(await proveInclusion({ ...input, target: git(f.dir, 'rev-parse', 'HEAD') })).toBeNull()
})

test('ancestry uses target, not previous, and confirms its tree after a revert', async () => {
  const f = fixture()
  const piece = commit(f.dir, { 'feature.txt': 'feature\n' })
  const target = commit(f.dir, { 'other.txt': 'unrelated\n' })
  expect(await proveInclusion({ ...f, pieceShas: [piece], previous: f.base, target }))
    .toEqual({ kind: 'ancestry', containingCommit: piece })
  git(f.dir, 'revert', '--no-edit', piece)
  const reverted = git(f.dir, 'rev-parse', 'HEAD')
  expect(await proveInclusion({ ...f, pieceShas: [piece], previous: f.base, target: reverted })).toBeNull()
  expect(await proveInclusion({ ...f, pieceShas: [piece], previous: target, target: f.base })).toBeNull()
})

test('a multi-commit piece starting at the root still requires the root changes', async () => {
  const f = fixture()
  git(f.dir, 'checkout', '-qb', 'piece')
  const piece = commit(f.dir, { 'feature.txt': 'feature\n' })
  expect(await proveInclusion({ ...f, pieceShas: [piece, f.base], target: piece }))
    .toEqual({ kind: 'ancestry', containingCommit: piece })
  git(f.dir, 'checkout', '-q', 'main')
  git(f.dir, 'rm', '-q', 'base.txt')
  const target = commit(f.dir, { 'feature.txt': 'feature\n', 'other.txt': 'other\n' })
  expect(await proveInclusion({ ...f, pieceShas: [f.base, piece], target })).toBeNull()
})

test('proof reads the exact target, preserving dirty checkout and staged index bytes', async () => {
  const f = fixture()
  const piece = commit(f.dir, { 'feature.txt': 'feature\n' })
  const target = commit(f.dir, { 'other.txt': 'other\n' })
  git(f.dir, 'checkout', '-q', '--detach', f.base)
  writeFileSync(join(f.dir, 'base.txt'), 'staged\n')
  git(f.dir, 'add', 'base.txt')
  writeFileSync(join(f.dir, 'base.txt'), 'dirty\n')
  const index = readFileSync(join(f.dir, '.git/index'))
  const status = git(f.dir, 'status', '--porcelain')
  expect(await proveInclusion({ ...f, pieceShas: [piece], target }))
    .toEqual({ kind: 'ancestry', containingCommit: piece })
  expect(readFileSync(join(f.dir, '.git/index'))).toEqual(index)
  expect(readFileSync(join(f.dir, 'base.txt'), 'utf8')).toBe('dirty\n')
  expect(git(f.dir, 'status', '--porcelain')).toBe(status)
  expect(git(f.dir, 'rev-parse', 'HEAD')).toBe(f.base)
})

test('missing objects, empty pieces, invalid refs and empty commits fail closed', async () => {
  const f = fixture()
  const input = { ...f, pieceShas: [f.base], target: f.base }
  expect(await proveInclusion({ ...input, pieceShas: [] })).toBeNull()
  expect(await proveInclusion({ ...input, pieceShas: ['f'.repeat(40)] })).toBeNull()
  expect(await proveInclusion({ ...input, target: '--all' })).toBeNull()
  expect(await proveInclusion({ ...input, target: 'f'.repeat(40) })).toBeNull()
  git(f.dir, 'commit', '-q', '--allow-empty', '-m', 'empty')
  expect(await proveInclusion({ ...input, pieceShas: [git(f.dir, 'rev-parse', 'HEAD')] })).toBeNull()
  expect(await squashPublishedIn(f.base, f.dir, f.repoKey)).toBe(false)
})

test('legacy wrapper rejects a patch reverted before its only release tag', async () => {
  const f = fixture()
  const piece = commit(f.dir, { 'feature.txt': 'feature\n' })
  git(f.dir, 'revert', '--no-edit', piece)
  git(f.dir, 'tag', 'v1.0.0')
  expect(await squashPublishedIn(piece, f.dir, f.repoKey)).toBe(false)
})
