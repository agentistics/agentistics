import { afterAll, afterEach, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gitTestEnv } from '@agentistics/core/gitTestEnv'
import { firstTagContaining, resetReleaseTagsForTest, tagDateIn } from './release-tags'
import { joinPieceReleases } from './task-web'

/**
 * CALENDARIO.VERSOES-DO-APP r3: two pieces whose commits ship in DIFFERENT tags, on different days, must each get
 * ONLY their own version and date. A real repository decides both facts; the join must not hand a piece the release
 * of a commit it never named.
 */

afterEach(async () => { await resetReleaseTagsForTest() })
const root = mkdtempSync(join(tmpdir(), 'piece-join-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))

const DAY_A = '2026-10-05T12:00:00Z'
const DAY_B = '2026-10-20T12:00:00Z'
const git = (dir: string, date: string, ...args: string[]) => {
  const stamp = `${Date.parse(date) / 1000} +0000`
  return execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', '-c', 'tag.gpgsign=false', ...args],
    { cwd: dir, env: { ...gitTestEnv(), GIT_AUTHOR_DATE: stamp, GIT_COMMITTER_DATE: stamp }, encoding: 'utf8' }).trim()
}
function commit(dir: string, date: string, file: string): string {
  writeFileSync(join(dir, file), `${file}\n`)
  git(dir, date, 'add', '-A')
  git(dir, date, 'commit', '-q', '-m', `c ${file}`)
  return git(dir, date, 'rev-parse', 'HEAD')
}

test('two pieces, two tags, two dates: each keeps its own release and nothing crosses over', async () => {
  const dir = join(root, 'repo')
  execFileSync('mkdir', [dir])
  git(dir, DAY_A, 'init', '-q', '-b', 'main')
  commit(dir, '2026-10-01T00:00:00Z', 'base.txt')
  git(dir, '2026-10-01T00:00:00Z', 'tag', 'v1.2.2')
  const shaA = commit(dir, DAY_A, 'a.txt')
  git(dir, DAY_A, 'tag', '-a', 'v1.2.3', '-m', 'v1.2.3')
  const shaB = commit(dir, DAY_B, 'b.txt')
  git(dir, DAY_B, 'tag', '-a', 'v1.3.0', '-m', 'v1.3.0')

  const versions = new Map<string, { version: string; publishedAt: number | null }>()
  for (const sha of [shaA, shaB]) {
    const version = await firstTagContaining(sha, [dir])
    expect(version).not.toBeNull()
    versions.set(sha, { version: version!, publishedAt: await tagDateIn(version!, [dir]) })
  }
  const pieces = new Map([
    [shaA, [{ taskId: 't1', subtaskId: 's-a' }]],
    [shaB, [{ taskId: 't1', subtaskId: 's-b' }]],
  ])

  const out = joinPieceReleases(pieces, versions)
  expect(out['t1/s-a']).toEqual({ version: '1.2.3', publishedAt: Date.parse(DAY_A) })
  expect(out['t1/s-b']).toEqual({ version: '1.3.0', publishedAt: Date.parse(DAY_B) })
  expect(Object.keys(out).sort()).toEqual(['t1/s-a', 't1/s-b'])
})
