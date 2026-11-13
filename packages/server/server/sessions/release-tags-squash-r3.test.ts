import { afterAll, afterEach, describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gitTestEnv } from '@agentistics/core/gitTestEnv'
import { firstTagContaining, resetReleaseTagsForTest } from './release-tags'

/**
 * CALENDARIO.REGISTRO-REAL r3 — the QA's hand recount, as a repository shaped like ours: every pull request lands by
 * SQUASH, releases follow each other one squash at a time, the delivered commit sits on a branch the tags never
 * contain, and the work is often OLDER than the newest few releases. A version is named only when a patch-id of the
 * delivered work EQUALS a commit's patch-id inside that release's own range; everything else is null (never a guess).
 *
 * Real counterparts (verified in the real clone on 2026-11-13):
 *  - `side` ≙ 05d93b753 "FIX 2.165.3 vidro": the whole branch squashed as f103a367f → v2.165.3, 40+ releases ago.
 *  - `preco` ≙ d99e4a7dc: delivered commit is the FIRST of two, branch squashed as b20c6efea (#1381) → v2.204.4.
 *  - `apiKey` ≙ 2180b9c63a: cherry-picked with other branches into one squash (#1341) — no patch-id is equal → null.
 *  - `central` ≙ 6828397c2/96ba97642: branch deleted, delivered commit not its head, squash (#1413) → null.
 *  - `jarvis` ≙ 0dbead048: no squash carries it; its change is in the tree only because a bigger commit holds it → null.
 */

afterEach(async () => { await resetReleaseTagsForTest() })

function inTmp(dir: string): string {
  if (!dir.startsWith(tmpdir() + '/')) throw new Error(`fixture refuses a directory outside ${tmpdir()}: ${dir}`)
  return dir
}
let clock = Date.parse('2026-10-01T00:00:00Z') / 1000
const git = (dir: string, ...args: string[]) => {
  clock += 3600
  const date = `${clock} +0000`
  return execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', '-c', 'tag.gpgsign=false', ...args],
    { cwd: inTmp(dir), env: { ...gitTestEnv(), GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date }, encoding: 'utf8' }).trim()
}
function commit(d: string, file: string, body: string, msg = `c ${file}`): string {
  writeFileSync(join(d, file), body)
  git(d, 'add', '-A')
  git(d, 'commit', '-q', '-m', msg)
  return git(d, 'rev-parse', 'HEAD')
}
/** Squash `files` from `branch` onto main as ONE commit and tag it — how a PR lands here. */
function squash(d: string, branch: string, files: string[], msg: string, tag: string): void {
  git(d, 'checkout', '-q', 'main')
  git(d, 'checkout', branch, '--', ...files)
  git(d, 'commit', '-q', '-m', msg)
  git(d, 'tag', tag)
}
/** One unrelated release, like the steady stream of squashes between the pieces. */
function filler(d: string, n: number): void {
  commit(d, `filler-${n}.txt`, `${n}\n`, `fix: unrelated ${n} (#${2000 + n})`)
  git(d, 'tag', `v2.${165 + n}.0`)
}

const root = mkdtempSync(join(tmpdir(), 'release-squash-r3-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))
const dir = inTmp(join(root, 'public'))
mkdirSync(dir, { recursive: true })
git(dir, 'init', '-q', '-b', 'main')
commit(dir, 'base.txt', 'base\n')
writeFileSync(join(dir, 'shared.txt'), 'line 1\nline 2\nline 3\n')
git(dir, 'add', '-A'); git(dir, 'commit', '-q', '-m', 'shared')
git(dir, 'tag', 'v2.160.0')

// side: a 3-commit batch branch, the delivered commit is its head; squashed whole → v2.165.3
git(dir, 'checkout', '-q', '-b', 'release/side')
commit(dir, 'glass-a.txt', 'a\n')
commit(dir, 'glass-b.txt', 'b\n')
const side = commit(dir, 'glass-c.txt', 'no shadow\n', 'fix(web): no shadow behind the message box')
squash(dir, 'release/side', ['glass-a.txt', 'glass-b.txt', 'glass-c.txt'], 'Side batch 2.166.0 (#1247)', 'v2.165.3')
for (let i = 1; i <= 3; i++) filler(dir, i)

// preco: two commits, the delivered one is the FIRST; the whole branch is squashed → v2.168.1
git(dir, 'checkout', '-q', '-b', 'fix/preco')
const preco = commit(dir, 'pricing.txt', 'gateway\n', 'fix(pricing): price gateway routes')
commit(dir, 'pricing-2.txt', 'unknown\n', 'fix(pricing): never price an unknown version')
squash(dir, 'fix/preco', ['pricing.txt', 'pricing-2.txt'], 'fix(pricing): price gateway routes (#1381)', 'v2.168.1')
for (let i = 4; i <= 6; i++) filler(dir, i)

// apiKey + live: two branches folded into ONE squash with other work → v2.171.1 (no patch-id is equal)
git(dir, 'checkout', '-q', '-b', 'feat/api-key')
commit(dir, 'key-1.txt', 'k1\n')
const apiKey = commit(dir, 'key-2.txt', 'refresh after warnings\n', 'fix(web): refresh usage after key warnings')
git(dir, 'checkout', '-q', 'main')
git(dir, 'checkout', '-q', '-b', 'perf/live')
commit(dir, 'live.txt', 'faster\n')
squash(dir, 'feat/api-key', ['key-1.txt', 'key-2.txt'], 'tmp', 'tmp-tag')
git(dir, 'tag', '-d', 'tmp-tag')
git(dir, 'checkout', 'perf/live', '--', 'live.txt')
git(dir, 'commit', '-q', '--amend', '-m', 'fix: Live speed, API key config (#1341)')
git(dir, 'tag', 'v2.171.1')
for (let i = 7; i <= 9; i++) filler(dir, i)

// central: three commits, delivered = the middle one, squash of all, branch DELETED → v2.174.1 (null)
git(dir, 'checkout', '-q', '-b', 'refactor/central')
commit(dir, 'central-1.txt', 'one\n')
const central = commit(dir, 'central-2.txt', 'two\n', 'docs: rewrite CLAUDE.md for the single local app')
commit(dir, 'central-3.txt', 'three\n')
squash(dir, 'refactor/central', ['central-1.txt', 'central-2.txt', 'central-3.txt'], 'refactor!: remove the team central (#1413)', 'v2.174.1')
git(dir, 'branch', '-q', '-D', 'refactor/central')

// head: the delivered commit IS the head of a since-deleted branch → v2.174.2 (proven: fork point..commit)
git(dir, 'checkout', '-q', '-b', 'fix/head')
commit(dir, 'head-1.txt', 'one\n')
const head = commit(dir, 'head-2.txt', 'two\n')
squash(dir, 'fix/head', ['head-1.txt', 'head-2.txt'], 'fix: head (#1415)', 'v2.174.2')
git(dir, 'branch', '-q', '-D', 'fix/head')

// jarvis: a commit on a deleted branch whose change reached main only inside a bigger commit → v2.174.3 (null)
git(dir, 'checkout', '-q', '-b', 'test/jarvis')
const jarvis = commit(dir, 'shared.txt', 'line 1\nline 2 (asi fix)\nline 3\n', 'test(engine): stop ASI')
git(dir, 'checkout', '-q', 'main')
git(dir, 'checkout', 'test/jarvis', '--', 'shared.txt')
writeFileSync(join(dir, 'other.txt'), 'more\n')
git(dir, 'add', '-A'); git(dir, 'commit', '-q', '-m', 'feat: a bigger change (#1420)')
git(dir, 'tag', 'v2.174.3')
git(dir, 'branch', '-q', '-D', 'test/jarvis')
// the newest releases, so every piece above is OLDER than the 3 newest tags (and `side` older than 12)
for (let i = 30; i <= 41; i++) filler(dir, i)

describe('r3 — a squash names a release only when a patch-id proves it', () => {
  test('a whole batch branch squashed 20+ releases ago resolves to THAT release, not a recent one', async () => {
    expect(await firstTagContaining(side, [dir])).toBe('2.165.3')
  })
  test('the first of two commits, its branch squashed whole, resolves through the branch diff', async () => {
    expect(await firstTagContaining(preco, [dir])).toBe('2.168.1')
  })
  test('a branch folded with others into one squash is unproven: null, never the newest tag', async () => {
    expect(await firstTagContaining(apiKey, [dir])).toBeNull()
  })
  test('a non-head commit of a deleted squashed branch is unproven: null', async () => {
    expect(await firstTagContaining(central, [dir])).toBeNull()
  })
  test('the head of a deleted squashed branch is proven by its fork point..commit diff', async () => {
    expect(await firstTagContaining(head, [dir])).toBe('2.174.2')
  })
  test('a change merely present in the tree (inside a bigger commit) names no release', async () => {
    expect(await firstTagContaining(jarvis, [dir])).toBeNull()
  })
})

describe('r3 — the EARLIEST tag across several clones wins, whatever order they are asked in', () => {
  const a = inTmp(join(root, 'clone-a'))
  const b = inTmp(join(root, 'clone-b'))
  mkdirSync(a, { recursive: true })
  git(a, 'init', '-q', '-b', 'main')
  const x = commit(a, 'x.txt', 'x\n')
  commit(a, 'y.txt', 'y\n')
  git(a, 'tag', 'v3.1.0')
  git(root, 'clone', '-q', '--no-tags', a, b)
  git(b, 'tag', 'v3.0.0', x)
  test('clone order [late, early] → the earliest version', async () => {
    expect(await firstTagContaining(x, [a, b])).toBe('3.0.0')
  })
  test('clone order [early, late] → the earliest version', async () => {
    await resetReleaseTagsForTest()
    expect(await firstTagContaining(x, [b, a])).toBe('3.0.0')
  })
})
