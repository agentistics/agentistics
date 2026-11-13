import { afterEach, describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gitTestEnv } from '@agentistics/core/gitTestEnv'
import { firstTagContaining, resetReleaseTagsForTest } from './release-tags'

afterEach(async () => { await resetReleaseTagsForTest() })

// Shaped like our real history: a work branch, landed on main by SQUASH ("subject (#N)"), then a release tag.
// Every git call runs with an explicit cwd inside a mkdtemp dir and no GIT_* variable (see release-tags.test.ts).
function inTmp(dir: string): string {
  if (!dir.startsWith(tmpdir() + '/')) throw new Error(`fixture refuses a directory outside ${tmpdir()}: ${dir}`)
  return dir
}
const git = (dir: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', '-c', 'tag.gpgsign=false', ...args], { cwd: inTmp(dir), env: gitTestEnv(), encoding: 'utf8' }).trim()
function commit(d: string, file: string, body: string, msg = `c ${file}`): string {
  writeFileSync(join(d, file), body)
  git(d, 'add', '-A')
  git(d, 'commit', '-q', '-m', msg)
  return git(d, 'rev-parse', 'HEAD')
}

describe('firstTagContaining on a squash-merged history', () => {
  const root = mkdtempSync(join(tmpdir(), 'release-squash-'))
  const dir = inTmp(join(root, 'public'))
  mkdirSync(dir, { recursive: true })
  git(dir, 'init', '-q', '-b', 'main')
  commit(dir, 'base.txt', 'base')
  git(dir, 'tag', 'v2.209.0')

  // PR #1422: two commits on a work branch, squashed into ONE commit on main, then released as 2.209.1.
  git(dir, 'checkout', '-q', '-b', 'fix/two-commits')
  const w1 = commit(dir, 'a.txt', 'one\n')
  const w2 = commit(dir, 'b.txt', 'two\n')
  git(dir, 'checkout', '-q', 'main')
  git(dir, 'checkout', 'fix/two-commits', '--', 'a.txt', 'b.txt')
  git(dir, 'commit', '-q', '-m', 'fix: two things (#1422)')
  git(dir, 'tag', 'v2.209.1')

  // PR #1423: a single commit, squashed, released one tag later.
  git(dir, 'checkout', '-q', '-b', 'fix/one-commit')
  const w3 = commit(dir, 'c.txt', 'three\n')
  git(dir, 'checkout', '-q', 'main')
  git(dir, 'checkout', 'fix/one-commit', '--', 'c.txt')
  git(dir, 'commit', '-q', '-m', 'fix: three (#1423)')
  commit(dir, 'bump.txt', '2.209.2', 'chore: bump version to 2.209.2 [skip ci]')
  git(dir, 'tag', 'v2.209.2')

  // A branch that never landed.
  git(dir, 'checkout', '-q', '-b', 'wip/never-landed')
  const wip = commit(dir, 'd.txt', 'unmerged\n')
  git(dir, 'checkout', '-q', 'main')

  test('a multi-commit squashed PR resolves to the first tag holding the squash', async () => {
    expect(await firstTagContaining(w1, [dir])).toBe('2.209.1')
    expect(await firstTagContaining(w2, [dir])).toBe('2.209.1')
  })
  test('a single-commit squashed PR resolves to its own release, not the newest', async () => {
    expect(await firstTagContaining(w3, [dir])).toBe('2.209.2')
  })
  test('work that never landed gets no version', async () => {
    expect(await firstTagContaining(wip, [dir])).toBeNull()
  })

  test('cleanup', () => { rmSync(root, { recursive: true, force: true }) })
})
