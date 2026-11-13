/**
 * Regression for the S1b pre-commit incident: inside a git hook, GIT_DIR / GIT_INDEX_FILE / GIT_WORK_TREE point at the REAL
 * repository, and a child `git` that inherits them ignores its cwd. Fixtures and production git calls must never inherit
 * a GIT_* variable. These tests export those variables pointing at a throwaway "victim" repo and prove it is untouched.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { cleanGitEnv, gitSpawnEnv } from './git-env'
import { gitSync, originWithClone, put } from './git-fixture.testing'
import { execGit, forgetClassifyCache, gatherFacts } from './classify-host'
import { declareClassification } from './classify-declare'
import { classifyPiece } from './classify'

let root: string
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'git-env-')); forgetClassifyCache() })
afterEach(() => rmSync(root, { recursive: true, force: true }))


/** A victim repository with a commit, a branch and a config — the stand-in for the real checkout. */
function victim(name: string) {
  const dir = join(root, name)
  gitSync(root, 'init', '-b', 'main', dir)
  put(dir, 'a.txt', 'one'); gitSync(dir, 'add', '-A'); gitSync(dir, 'commit', '-m', 'one'); gitSync(dir, 'branch', 'side')
  return dir
}
const snapshot = (dir: string) => ({
  head: gitSync(dir, 'rev-parse', 'HEAD'),
  branch: gitSync(dir, 'symbolic-ref', 'HEAD'),
  refs: gitSync(dir, 'for-each-ref'),
  bare: gitSync(dir, 'config', '--get', 'core.bare'),
  config: readFileSync(join(dir, '.git', 'config'), 'utf8'),
  index: readFileSync(join(dir, '.git', 'index')).toString('base64'),
  objects: readdirSync(join(dir, '.git', 'objects')).sort().join(','),
})

/** Export the hook's variables pointing at `v` for the duration of `fn`, restore after. */
async function inHook<T>(v: string, fn: () => Promise<T> | T): Promise<T> {
  const saved: Record<string, string | undefined> = {}
  const want = { GIT_DIR: join(v, '.git'), GIT_INDEX_FILE: join(v, '.git', 'index'), GIT_WORK_TREE: v, GIT_PREFIX: '', GIT_COMMON_DIR: join(v, '.git') }
  for (const k of Object.keys(want)) saved[k] = process.env[k]
  Object.assign(process.env, want)
  try { return await fn() } finally { for (const [k, old] of Object.entries(saved)) { if (old === undefined) delete process.env[k]; else process.env[k] = old } }
}

describe('the environment helper', () => {
  test('cleanGitEnv drops every GIT_* key and keeps the rest; gitSpawnEnv adds only what it names', () => {
    const base = { PATH: '/bin', HOME: '/h', GIT_DIR: '/real/.git', GIT_INDEX_FILE: '/real/.git/index', GIT_WORK_TREE: '/real', GIT_PREFIX: 'x/', GIT_ANYTHING: '1', LANG: 'C' }
    expect(cleanGitEnv(base)).toEqual({ PATH: '/bin', HOME: '/h', LANG: 'C' })
    const spawn = gitSpawnEnv({ GIT_AUTHOR_NAME: 't' }, base)
    expect(Object.keys(spawn).filter(k => k.startsWith('GIT_')).sort()).toEqual(['GIT_AUTHOR_NAME', 'GIT_TERMINAL_PROMPT'])
    expect(spawn.GIT_DIR).toBeUndefined()
  })
  test('the fixture helper refuses a cwd outside the temp directory', () => {
    expect(() => gitSync('/', 'status')).toThrow(/not inside the temp directory/)
    expect(() => gitSync(process.cwd(), 'status')).toThrow(/not inside the temp directory/)
  })
})

describe('CONTROL — the hazard is real: a raw spawn that inherits the hook variables writes into the victim', () => {
  test('`git commit` run with an inherited GIT_DIR lands in the victim, not in its own cwd', () => {
    const v = victim('v-control'); const elsewhere = join(root, 'elsewhere'); gitSync(root, 'init', '-b', 'main', elsewhere)
    const before = gitSync(v, 'rev-parse', 'HEAD')
    const env = { ...cleanGitEnv(), GIT_DIR: join(v, '.git'), GIT_WORK_TREE: v, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' }
    const p = Bun.spawnSync(['git', 'commit', '--allow-empty', '-m', 'oops'], { cwd: elsewhere, env, stdout: 'pipe', stderr: 'pipe' })
    expect(p.exitCode).toBe(0)
    expect(gitSync(v, 'rev-parse', 'HEAD')).not.toBe(before)
  })
})

describe('the guard\'s git use never reaches the victim', () => {
  test('fixtures (init, clone, commit, branch -M, push) with the hook variables exported leave the victim byte-identical', async () => {
    const v = victim('v1'); const before = snapshot(v)
    const made = await inHook(v, () => {
      const { repo } = originWithClone(root, 'fx')
      gitSync(repo, 'checkout', '-b', 'feat/x'); put(repo, 'packages/web/a.tsx'); gitSync(repo, 'add', '-A'); gitSync(repo, 'commit', '-m', 'web')
      return repo
    })
    expect(snapshot(v)).toEqual(before)
    // and the fixture really was built where it should be
    expect(gitSync(made, 'symbolic-ref', '--short', 'HEAD')).toBe('feat/x')
  })

  test('production git reads (execGit, gatherFacts, declareClassification) with the hook variables exported act on the NAMED repository only', async () => {
    const v = victim('v2'); const before = snapshot(v)
    const { repo } = originWithClone(root, 'fx2')
    gitSync(repo, 'checkout', '-b', 'feat/x'); put(repo, 'packages/web/a.tsx'); gitSync(repo, 'add', '-A'); gitSync(repo, 'commit', '-m', 'web'); gitSync(repo, 'push', '-u', 'origin', 'feat/x')
    const head = gitSync(repo, 'rev-parse', 'HEAD')
    const deps = { sessions: async () => [{ id: 's', cwd: repo, taskId: 't', subtaskId: 'p', createdAt: '2026-11-13T10:00:00Z' }], git: execGit }
    const out = await inHook(v, async () => ({
      toplevel: (await execGit(repo, ['rev-parse', '--show-toplevel'])).trim(),
      head: (await execGit(repo, ['rev-parse', 'HEAD'])).trim(),
      verdict: classifyPiece(await gatherFacts(deps, { taskId: 't', subtaskId: 'p' })),
      declared: await declareClassification(deps, { piece: { taskId: 't', subtaskId: 'p' }, repo, head }),
    }))
    expect(out.toplevel).toContain('fx2'); expect(out.head).toBe(head)
    expect(out.verdict).toMatchObject({ ok: true, category: 'screen', headSha: head })
    expect(out.declared).toMatchObject({ ok: true })
    expect(snapshot(v)).toEqual(before)
  })

  test('mutation: if execGit passed the inherited environment through, this test would fail (the victim would answer)', async () => {
    const v = victim('v3'); const { repo } = originWithClone(root, 'fx3')
    const viaInherited = await inHook(v, () => {
      const p = Bun.spawnSync(['git', '-C', repo, 'rev-parse', 'HEAD'], { env: { ...process.env }, stdout: 'pipe', stderr: 'pipe' })
      return p.stdout.toString().trim()
    })
    const viaHelper = await inHook(v, async () => (await execGit(repo, ['rev-parse', 'HEAD'])).trim())
    expect(viaInherited).toBe(gitSync(v, 'rev-parse', 'HEAD'))       // the inherited env answers FOR THE VICTIM
    expect(viaHelper).toBe(gitSync(repo, 'rev-parse', 'HEAD'))       // the helper answers for the repository it was asked about
    expect(viaHelper).not.toBe(viaInherited)
  })
})
