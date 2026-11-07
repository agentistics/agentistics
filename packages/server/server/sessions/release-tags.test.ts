import { afterEach, describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gitEnv } from './release-repos'
import { publishedAmong, publishedIn, releaseTagsIdle, resetReleaseTagsForTest, tagContainsIn } from './release-tags'

afterEach(async () => { await resetReleaseTagsForTest() })

describe('release-tags (the cached tag lookup the Live asks, never per request)', () => {
  test('unknown commits resolve in the background; the next ask knows them', async () => {
    let calls = 0
    const ask = async (sha: string) => { calls++; return sha === 'aaaaaaa1' }
    expect([...publishedAmong(['aaaaaaa1', 'bbbbbbb2'], 1000, ask)]).toEqual([])
    await releaseTagsIdle()
    expect([...publishedAmong(['aaaaaaa1', 'bbbbbbb2'], 2000, ask)]).toEqual(['aaaaaaa1'])
    expect(calls).toBe(2)
    // positive stays forever, negative is not asked again inside its TTL
    publishedAmong(['aaaaaaa1', 'bbbbbbb2'], 3000, ask)
    await releaseTagsIdle()
    expect(calls).toBe(2)
  })
  test('a negative answer expires, so a tag published later is found', async () => {
    let published = false
    const ask = async () => published
    publishedAmong(['ccccccc3'], 0, ask)
    await releaseTagsIdle()
    published = true
    publishedAmong(['ccccccc3'], 60_000, ask)
    await releaseTagsIdle()
    expect(publishedAmong(['ccccccc3'], 61_000, ask).has('ccccccc3')).toBe(false)
    publishedAmong(['ccccccc3'], 11 * 60_000, ask)
    await releaseTagsIdle()
    expect(publishedAmong(['ccccccc3'], 11 * 60_000 + 1, ask).has('ccccccc3')).toBe(true)
  })
  test('a non-hex argument is never passed to git', async () => {
    const d = mkdtempSync(join(tmpdir(), 'release-tags-hex-'))
    expect(await tagContainsIn('--all', d)).toBe(false)
    expect(await tagContainsIn('zzzzzzzz', d)).toBe(false)
    rmSync(d, { recursive: true, force: true })
  })
})

// ---- real repositories: the server does not run inside a checkout, and a delivery spans repositories ----
//
// EVERY git call of a fixture runs with an explicit cwd INSIDE a mkdtemp directory and with no `GIT_*` variable in
// its environment. The pre-commit hook exports GIT_DIR / GIT_INDEX_FILE for the checkout being committed, and a
// `git -C <tmp>` that inherits them operates on THAT checkout — a fixture commit once landed on a real branch.

/** Refuses a directory that is not under the OS temp directory: a fixture may never touch anything else. */
function inTmp(dir: string): string {
  if (!dir.startsWith(tmpdir() + '/')) throw new Error(`fixture refuses a directory outside ${tmpdir()}: ${dir}`)
  return dir
}
const git = (dir: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', '-c', 'tag.gpgsign=false', ...args], { cwd: inTmp(dir), env: gitEnv(), encoding: 'utf8' }).trim()

function repo(root: string, name: string): string {
  const d = inTmp(join(root, name))
  mkdirSync(d, { recursive: true })
  git(d, 'init', '-q', '-b', 'main')
  return d
}
function commit(d: string, file: string, body: string): string {
  writeFileSync(join(d, file), body)
  git(d, 'add', '-A')
  git(d, 'commit', '-q', '-m', `c ${file}`)
  return git(d, 'rev-parse', 'HEAD')
}

describe('release-tags in real repositories', () => {
  const root = mkdtempSync(join(tmpdir(), 'release-tags-'))
  const outside = mkdtempSync(join(tmpdir(), 'release-tags-cwd-')) // NOT a git checkout: where the installed server runs
  const pub = repo(root, 'public')
  const eng = repo(root, 'engine')
  const unrelated = repo(root, 'unrelated')

  const inTag = commit(pub, 'a.txt', '1')
  git(pub, 'tag', 'v1.0.0')

  const engOld = commit(eng, 'e1.txt', '1')
  const engPinned = commit(eng, 'e2.txt', '2')
  const engAfter = commit(eng, 'e3.txt', '3')
  // the public release v1.1.0 pins the engine at engPinned
  writeFileSync(join(pub, 'engine.pin'), JSON.stringify({ ref: engPinned, api: '^1.0.0' }))
  git(pub, 'add', '-A'); git(pub, 'commit', '-q', '-m', 'pin engine')
  git(pub, 'tag', 'v1.1.0')
  const untagged = commit(pub, 'b.txt', '2') // after the last release: in no tag
  commit(unrelated, 'u.txt', 'x')

  test('FIX1: a server whose cwd is outside any git checkout still finds the tag, through the piece’s own repository', async () => {
    const before = process.cwd()
    process.chdir(outside)
    try {
      // without the fix the only clone asked was process.cwd(), i.e. `outside`
      expect(await tagContainsIn(inTag, outside)).toBe(false)
      expect(await publishedIn(inTag, [pub])).toBe(true)
      expect(await publishedIn(untagged, [pub])).toBe(false)
    } finally { process.chdir(before) }
  })

  test('no clone named means NO answer — the process directory is never the fallback', async () => {
    const before = process.cwd()
    process.chdir(pub) // the commit IS reachable from here; it must still not be found without being asked there
    try { expect(await publishedIn(inTag, [])).toBe(false) } finally { process.chdir(before) }
  })

  test('GIT_* variables of a hook do not redirect the lookup (the test suite runs inside pre-commit)', async () => {
    const saved = { dir: process.env.GIT_DIR, idx: process.env.GIT_INDEX_FILE, wt: process.env.GIT_WORK_TREE }
    process.env.GIT_DIR = join(outside, 'not-a-git-dir'); process.env.GIT_INDEX_FILE = join(outside, 'no-index'); process.env.GIT_WORK_TREE = outside
    try { expect(await publishedIn(inTag, [pub])).toBe(true) } finally {
      for (const [k, v] of [['GIT_DIR', saved.dir], ['GIT_INDEX_FILE', saved.idx], ['GIT_WORK_TREE', saved.wt]] as const) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
    }
  })

  test('FIX1: the clone list is asked in order and a directory that is not a repository (or is gone) is skipped', async () => {
    expect(await publishedIn(inTag, [outside, join(root, 'gone'), unrelated, pub])).toBe(true)
  })

  test('FIX1: two worktrees of one repository are one repository', async () => {
    const wt = join(root, 'wt')
    git(pub, 'worktree', 'add', '-q', '--detach', wt, 'HEAD')
    expect(await publishedIn(inTag, [wt, pub])).toBe(true)
  })

  test('FIX1: publishedAmong resolves per commit through dirsFor, and a miss is cached (git is not asked again)', async () => {
    let asks = 0
    const ask = async (sha: string, dirs: readonly string[]) => { asks++; return publishedIn(sha, dirs) }
    const dirsFor = () => [pub]
    publishedAmong([inTag, untagged], 1000, ask, dirsFor)
    await releaseTagsIdle()
    expect([...publishedAmong([inTag, untagged], 2000, ask, dirsFor)]).toEqual([inTag])
    expect(asks).toBe(2)
    publishedAmong([inTag, untagged], 3000, ask, dirsFor)
    await releaseTagsIdle()
    expect(asks).toBe(2)
  })

  test('FIX2: an ENGINE commit is published when a public release pins an engine commit that contains it', async () => {
    expect(await publishedIn(engOld, [eng, pub])).toBe(true)
    expect(await publishedIn(engPinned, [eng, pub])).toBe(true)
    // newer than the pin: not in any release yet
    expect(await publishedIn(engAfter, [eng, pub])).toBe(false)
    // without the public repo among the clones there is no pin to compare against
    expect(await publishedIn(engOld, [eng])).toBe(false)
  })

  test('FIX2b: a SQUASH-merged pull request is published although the worker\'s commits are in no tag', async () => {
    const sq = repo(root, 'squash')
    commit(sq, 'base.txt', 'base')
    git(sq, 'tag', 'v1.0.0')
    git(sq, 'checkout', '-q', '-b', 'feat/x')
    const f1 = commit(sq, 'x1.txt', 'one\n')
    const f2 = commit(sq, 'x2.txt', 'two\n')
    git(sq, 'update-ref', 'refs/remotes/origin/feat/x', f2)
    git(sq, 'checkout', '-q', 'main')
    git(sq, 'checkout', '-q', '-b', 'feat/other')
    const o1 = commit(sq, 'o.txt', 'other\n')
    git(sq, 'update-ref', 'refs/remotes/origin/feat/other', o1)
    git(sq, 'checkout', '-q', 'main')
    // the PR lands as ONE new commit
    git(sq, 'merge', '--squash', 'feat/x')
    git(sq, 'commit', '-q', '-m', 'feat: x (#1)')
    git(sq, 'tag', 'v1.1.0')
    // neither of the worker's commits is reachable from a tag...
    expect(await tagContainsIn(f2, sq)).toBe(false)
    expect(await tagContainsIn(f1, sq)).toBe(false)
    // ...yet its work is in v1.1.0: the tip through the whole-branch diff, the first commit through the same branch
    expect(await publishedIn(f2, [sq])).toBe(true)
    expect(await publishedIn(f1, [sq])).toBe(true)
    // a different, unmerged branch is not
    expect(await publishedIn(o1, [sq])).toBe(false)
  })

  test('FIX2c: ONE squash that folds SEVERAL branches (2.200.7 was three) publishes each of them', async () => {
    const sq = repo(root, 'squash-many')
    commit(sq, 'base.txt', 'base')
    git(sq, 'tag', 'v1.0.0')
    const tips: string[] = []
    for (const n of ['a', 'b', 'c']) {
      git(sq, 'checkout', '-q', '-b', `fix/${n}`, 'main')
      tips.push(commit(sq, `${n}.txt`, `${n}\n`))
      commit(sq, `${n}2.txt`, `${n}2\n`)
      tips[tips.length - 1] = git(sq, 'rev-parse', 'HEAD')
    }
    git(sq, 'checkout', '-q', 'main')
    git(sq, 'checkout', '-q', '-b', 'fix/unmerged', 'main')
    const lone = commit(sq, 'lone.txt', 'lone\n')
    git(sq, 'checkout', '-q', 'main')
    // all three land as one commit: no single patch-id can match it
    for (const n of ['a', 'b', 'c']) git(sq, 'merge', '--squash', `fix/${n}`)
    git(sq, 'commit', '-q', '-m', 'fix: three things (#2)')
    git(sq, 'tag', 'v1.1.0')
    for (const t of tips) { expect(await tagContainsIn(t, sq)).toBe(false); expect(await publishedIn(t, [sq])).toBe(true) }
    expect(await publishedIn(lone, [sq])).toBe(false)
  })

  test('a git call has a timeout and a failure is "no", never "published"', async () => {
    expect(await publishedIn('abcdef1234567', [join(root, 'nothing-here')])).toBe(false)
  })

  test('cleanup', () => { rmSync(root, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }) })
})
