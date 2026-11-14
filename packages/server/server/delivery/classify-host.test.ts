/**
 * S1b — classify-host against REAL git repositories in a throwaway directory (never the user's repos).
 * §3.2: the piece's checkout comes from the cwd of the sessions filed under it; HEAD, `git status --porcelain` and
 * `git diff --name-only <merge-base>..HEAD` are read at every call; the diff part is cached by (repo, HEAD, dirty hash).
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { classifyPiece } from './classify'
import { gitSync, originWithClone, put } from './git-fixture.testing'
import { cwdsOfPiece, execGit, forgetClassifyCache, gatherFacts, parseNameStatusZ, parseStatusZ, type ClassifyDeps, type ClassifySession } from './classify-host'

let root: string
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'classify-host-')); forgetClassifyCache() })
afterEach(() => rmSync(root, { recursive: true, force: true }))

// Every git spawn goes through the shared helper: no inherited GIT_* (a pre-commit hook exports the REAL repo's), temp cwd only.
const git = gitSync

/** A bare origin with `main` pushed and a clone on a feature branch — the shape of a worker's worktree. */
function fixture(name = 'a'): { origin: string; repo: string } {
  const { origin, repo } = originWithClone(root, name)
  git(repo, 'checkout', '-b', 'feat/x')
  return { origin, repo }
}
const commit = (repo: string, rel: string, text = 'changed') => { put(repo, rel, text); git(repo, 'add', '-A'); git(repo, 'commit', '-m', `edit ${rel}`) }

const deps = (sessions: ClassifySession[], over: Partial<ClassifyDeps> = {}): ClassifyDeps => ({ sessions: async () => sessions, git: execGit, ...over })
const sess = (cwd: string, over: Partial<ClassifySession> = {}): ClassifySession => ({ id: 's1', cwd, taskId: 't1', subtaskId: 'p1', createdAt: '2026-11-13T10:00:00Z', ...over })
const piece = { taskId: 't1', subtaskId: 'p1' }
const classify = async (d: ClassifyDeps) => classifyPiece(await gatherFacts(d, piece))

describe('§3.2 rows against real git', () => {
  test('screen: a committed packages/web change', async () => {
    const { repo } = fixture(); commit(repo, 'packages/web/src/a.tsx')
    expect(await classify(deps([sess(repo)]))).toMatchObject({ ok: true, category: 'screen', headSha: git(repo, 'rev-parse', 'HEAD') })
  })
  test('code: a committed server change', async () => {
    const { repo } = fixture(); commit(repo, 'packages/server/server/b.ts')
    expect(await classify(deps([sess(repo)]))).toMatchObject({ ok: true, category: 'code' })
  })
  test('docs: only docs/** and *.md', async () => {
    const { repo } = fixture(); commit(repo, 'docs/a.md'); commit(repo, 'README.md', '# y')
    expect(await classify(deps([sess(repo)]))).toMatchObject({ ok: true, category: 'docs' })
  })
  test('none-verified: a resolved, clean checkout with an empty diff against the base', async () => {
    const { repo } = fixture()
    expect(await classify(deps([sess(repo)]))).toMatchObject({ ok: true, category: 'none-verified' })
  })
  test('the merge-base is used: a base that moved on does not leak into the piece\'s diff', async () => {
    const { repo, origin } = fixture(); commit(repo, 'docs/a.md')
    const other = join(root, 'other'); git(root, 'clone', origin, other)
    commit(other, 'packages/web/src/elsewhere.tsx'); git(other, 'push', 'origin', 'HEAD:main'); git(repo, 'fetch', 'origin')
    expect(await classify(deps([sess(repo)]))).toMatchObject({ ok: true, category: 'docs' })
  })
})

describe('§3.5.12 / §3.5.13 / unknown', () => {
  test('NO-COMMIT ATTACK: an uncommitted edit to a web file → uncommitted_changes (an empty committed diff is NOT research)', async () => {
    const { repo } = fixture(); put(repo, 'packages/web/x.tsx', 'export {}')
    expect(await classify(deps([sess(repo)]))).toMatchObject({ ok: false, code: 'uncommitted_changes' })
  })
  test('an uncommitted edit to a tracked .ts file after a clean state → uncommitted_changes', async () => {
    const { repo } = fixture(); commit(repo, 'packages/server/server/b.ts'); put(repo, 'packages/server/server/b.ts', 'dirty')
    expect(await classify(deps([sess(repo)]))).toMatchObject({ ok: false, code: 'uncommitted_changes' })
  })
  test('an uncommitted doc is allowed', async () => {
    const { repo } = fixture(); commit(repo, 'packages/server/server/b.ts'); put(repo, 'docs/draft.md', 'wip')
    expect(await classify(deps([sess(repo)]))).toMatchObject({ ok: true, category: 'code' })
  })
  test('several uncommitted docs (a root .md and a docs/ file) are all read as docs — the status is parsed record by record', async () => {
    const { repo } = fixture(); commit(repo, 'packages/server/server/b.ts')
    put(repo, 'NOTES.md', 'wip'); put(repo, 'docs/draft.md', 'wip'); put(repo, 'docs/more.md', 'wip')
    expect(await classify(deps([sess(repo)]))).toMatchObject({ ok: true, category: 'code' })
    put(repo, 'packages/server/server/oops.ts', 'x')
    expect(await classify(deps([sess(repo)]))).toMatchObject({ ok: false, code: 'uncommitted_changes', paths: ['packages/server/server/oops.ts'] })
  })
  test('a piece with no filed session → classification_required (never docs/none-verified by silence)', async () => {
    const r = await classify(deps([]))
    expect(r).toMatchObject({ ok: false, code: 'classification_required', nonCodeOnly: true })
  })
  test('sessions filed under ANOTHER piece do not count', async () => {
    const { repo } = fixture()
    expect(await classify(deps([sess(repo, { subtaskId: 'other' })]))).toMatchObject({ ok: false, code: 'classification_required' })
  })
  test('a cwd that is not a repository → classification_required', async () => {
    const plain = join(root, 'plain'); mkdirSync(plain)
    expect(await classify(deps([sess(plain)]))).toMatchObject({ ok: false, code: 'classification_required' })
  })
  test('a removed worktree → classification_required (the leader can declare, §3.2 N9)', async () => {
    expect(await classify(deps([sess(join(root, 'gone'))]))).toMatchObject({ ok: false, code: 'classification_required' })
  })
  test('base unresolvable (no origin/dev, origin/main, dev or main) → classification_required', async () => {
    const lone = join(root, 'lone'); mkdirSync(lone); git(lone, 'init', '-b', 'trunk'); put(lone, 'a.txt'); git(lone, 'add', '-A'); git(lone, 'commit', '-m', 'x')
    expect(await classify(deps([sess(lone)]))).toMatchObject({ ok: false, code: 'classification_required' })
  })
  test('the newest filed session with a resolvable repository wins; an older/removed one is skipped', async () => {
    const { repo } = fixture(); commit(repo, 'docs/a.md')
    const r = await classify(deps([sess(join(root, 'gone'), { id: 'new', createdAt: '2026-11-13T12:00:00Z' }), sess(repo, { id: 'old', createdAt: '2026-11-13T09:00:00Z' })]))
    expect(r).toMatchObject({ ok: true, category: 'docs' })
  })
})

describe('QA r2 F3 — renames count BOTH sides', () => {
  test('a STAGED rename code → docs is uncommitted_changes (the removed code is real uncommitted work)', async () => {
    const { repo } = fixture(); commit(repo, 'packages/server/server/b.ts')
    mkdirSync(join(repo, 'docs'), { recursive: true }); git(repo, 'mv', 'packages/server/server/b.ts', 'docs/b.md')
    expect(await classify(deps([sess(repo)]))).toMatchObject({ ok: false, code: 'uncommitted_changes' })
  })
  test('a STAGED rename of a screen file into docs is uncommitted_changes too', async () => {
    const { repo } = fixture(); commit(repo, 'packages/web/src/s.tsx')
    mkdirSync(join(repo, 'docs'), { recursive: true }); git(repo, 'mv', 'packages/web/src/s.tsx', 'docs/s.md')
    expect(await classify(deps([sess(repo)]))).toMatchObject({ ok: false, code: 'uncommitted_changes' })
  })
  test('a COMMITTED rename code → docs is not "docs only": the old side keeps the category at code', async () => {
    const { repo } = fixture()   // packages/server/server/a.ts already exists on main
    mkdirSync(join(repo, 'docs'), { recursive: true }); git(repo, 'mv', 'packages/server/server/a.ts', 'docs/b.md'); git(repo, 'commit', '-m', 'move to docs')
    expect(await classify(deps([sess(repo)]))).toMatchObject({ ok: true, category: 'code' })
  })
  test('a COMMITTED rename of a web file into docs stays a SCREEN change', async () => {
    const { repo } = fixture(); commit(repo, 'packages/web/src/s.tsx'); git(repo, 'push', 'origin', 'HEAD:main')   // the screen file is on main
    mkdirSync(join(repo, 'docs'), { recursive: true }); git(repo, 'mv', 'packages/web/src/s.tsx', 'docs/s.md'); git(repo, 'commit', '-m', 'move to docs')
    expect(await classify(deps([sess(repo)]))).toMatchObject({ ok: true, category: 'screen' })
  })
})

describe('QA r2 F4 — paths git would quote are read NUL-delimited, verbatim', () => {
  test('a non-ASCII file under packages/web is a SCREEN change (committed) and refuses when dirty', async () => {
    const { repo } = fixture(); commit(repo, 'packages/web/src/ação.tsx')
    expect(await classify(deps([sess(repo)]))).toMatchObject({ ok: true, category: 'screen' })
    put(repo, 'packages/server/server/ção.ts', 'x')
    expect(await classify(deps([sess(repo)]))).toMatchObject({ ok: false, code: 'uncommitted_changes' })
  })
  test('quotes and a newline in a web file name stay a screen change', async () => {
    const { repo } = fixture(); commit(repo, 'packages/web/src/we"ird\nname.tsx')
    expect(await classify(deps([sess(repo)]))).toMatchObject({ ok: true, category: 'screen' })
  })
  test('a non-ASCII DOC under docs/ is docs, not code', async () => {
    const { repo } = fixture(); commit(repo, 'docs/relatório.md')
    expect(await classify(deps([sess(repo)]))).toMatchObject({ ok: true, category: 'docs' })
  })
})

describe('QA r2 — the cache key includes the merge-base, and the base is re-read on every call', () => {
  test('HEAD and status unchanged, the release line moves to another ancestor → the category is recomputed (a warm cache equals a cold one)', async () => {
    const { repo, origin } = fixture(); commit(repo, 'docs/a.md')                      // feature: docs on top of main@0
    const d = deps([sess(repo)])
    expect(await classify(d)).toMatchObject({ ok: true, category: 'docs' })           // warms the cache
    // main absorbs the feature's commit then moves on: the merge-base becomes HEAD itself → an EMPTY diff
    git(repo, 'push', 'origin', 'HEAD:main'); git(repo, 'fetch', 'origin')
    const warm = await classify(d)
    forgetClassifyCache()
    const cold = await classify(d)
    expect(warm).toEqual(cold); expect(warm).toMatchObject({ ok: true, category: 'none-verified' })
    void origin
  })
  test('the release line disappears at the same HEAD/status → classification_required, not the cached category', async () => {
    const { repo } = fixture(); commit(repo, 'docs/a.md')
    const d = deps([sess(repo)])
    expect(await classify(d)).toMatchObject({ ok: true, category: 'docs' })
    git(repo, 'branch', '-m', 'main', 'gone-main'); git(repo, 'update-ref', '-d', 'refs/remotes/origin/main')
    expect(await classify(d)).toMatchObject({ ok: false, code: 'classification_required' })
  })
})

describe('cache by (repo, HEAD, dirty hash) — and it never answers for a different HEAD or dirt', () => {
  const counting = () => { const calls: string[] = []; return { calls, git: async (cwd: string, args: string[]) => { calls.push(args.join(' ')); return execGit(cwd, args) } } }
  test('a second call at the same HEAD and dirt does not re-run the diff; a new commit or new dirt does', async () => {
    const { repo } = fixture(); commit(repo, 'docs/a.md')
    const c = counting(); const d = deps([sess(repo)], { git: c.git })
    await gatherFacts(d, piece); const first = c.calls.filter(x => x.startsWith('diff')).length
    await gatherFacts(d, piece); expect(c.calls.filter(x => x.startsWith('diff')).length).toBe(first)
    commit(repo, 'packages/web/src/z.tsx')
    expect(await classify(d)).toMatchObject({ ok: true, category: 'screen' })
    expect(c.calls.filter(x => x.startsWith('diff')).length).toBe(first + 1)
    put(repo, 'packages/server/server/dirty.ts', 'x')
    expect(await classify(d)).toMatchObject({ ok: false, code: 'uncommitted_changes' })
  })
  test('HEAD and `status --porcelain` are read on EVERY call (the guard runs at every move)', async () => {
    const { repo } = fixture(); const c = counting(); const d = deps([sess(repo)], { git: c.git })
    await gatherFacts(d, piece); await gatherFacts(d, piece)
    expect(c.calls.filter(x => x.startsWith('rev-parse HEAD')).length).toBe(2)
    expect(c.calls.filter(x => x.startsWith('status')).length).toBe(2)
  })
})

describe('pure helpers', () => {
  test('parseStatusZ (NUL-delimited): paths verbatim, a rename/copy yields BOTH sides, " -> " in a name is not a rename', () => {
    const z = (...p: string[]) => p.join('\0') + '\0'
    expect(parseStatusZ(z(' M packages/web/a.tsx', '?? docs/b.md', 'R  new.ts', 'old.ts', 'A  sp ace.ts'))).toEqual(['packages/web/a.tsx', 'docs/b.md', 'new.ts', 'old.ts', 'sp ace.ts'])
    expect(parseStatusZ(z('?? a -> b.ts'))).toEqual(['a -> b.ts'])
    expect(parseStatusZ(z('?? packages/web/src/ação.tsx', ' M "quoted".ts'))).toEqual(['packages/web/src/ação.tsx', '"quoted".ts'])
    expect(parseStatusZ(z('C  copy.ts', 'orig.ts'))).toEqual(['copy.ts', 'orig.ts'])
    expect(parseStatusZ('')).toEqual([])
  })
  test('parseNameStatusZ: modified/added/deleted one path, rename/copy both, names verbatim', () => {
    const z = (...p: string[]) => p.join('\0') + '\0'
    expect(parseNameStatusZ(z('M', 'a.ts', 'A', 'docs/b.md', 'D', 'c.ts', 'R100', 'old.ts', 'new.md', 'C75', 'src.ts', 'dst.ts'))).toEqual(['a.ts', 'docs/b.md', 'c.ts', 'old.ts', 'new.md', 'src.ts', 'dst.ts'])
    expect(parseNameStatusZ(z('A', 'packages/web/src/ação.tsx', 'M', 'we"ird\nname.tsx'))).toEqual(['packages/web/src/ação.tsx', 'we"ird\nname.tsx'])
    expect(parseNameStatusZ('')).toEqual([])
  })
  test('cwdsOfPiece: only the piece\'s own rows (task-level piece = rows with no subtask), newest first, unique, non-empty', () => {
    const rows: ClassifySession[] = [
      sess('/a', { id: '1', createdAt: '2026-11-13T09:00:00Z' }), sess('/b', { id: '2', createdAt: '2026-11-13T11:00:00Z' }), sess('/a', { id: '3', createdAt: '2026-11-13T12:00:00Z' }),
      sess('', { id: '4' }), sess('/c', { id: '5', subtaskId: 'zzz' }), sess('/d', { id: '6', taskId: 't2' }),
    ]
    expect(cwdsOfPiece(rows, { taskId: 't1', subtaskId: 'p1' })).toEqual(['/a', '/b'])
    expect(cwdsOfPiece([sess('/t', { subtaskId: undefined })], { taskId: 't1' })).toEqual(['/t'])
  })
})
