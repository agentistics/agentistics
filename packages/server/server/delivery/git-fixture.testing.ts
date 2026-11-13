/**
 * Test-only git helpers for the delivery guard's real-git fixtures. EVERY spawn goes through `gitSync`:
 *  - the environment has no inherited `GIT_*` variable (`gitSpawnEnv`), so a test run inside a git hook (husky exports
 *    GIT_DIR / GIT_INDEX_FILE / GIT_WORK_TREE pointing at the REAL repository) cannot touch that repository;
 *  - the cwd is explicit and must be inside the OS temp directory — a fixture that points anywhere else throws before git runs.
 */
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { gitSpawnEnv } from './git-env'

const TMP = realpathSync(tmpdir())
const AUTHOR = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' }

function assertTemp(cwd: string): void {
  const abs = resolve(cwd)
  const real = (() => { try { return realpathSync(abs) } catch { return abs } })()
  if (!(real === TMP || real.startsWith(TMP + sep) || abs === tmpdir() || abs.startsWith(tmpdir() + sep))) {
    throw new Error(`git fixture refused: ${cwd} is not inside the temp directory`)
  }
}

export function gitSync(cwd: string, ...args: string[]): string {
  assertTemp(cwd)
  const p = Bun.spawnSync(['git', '-c', 'commit.gpgsign=false', '-C', cwd, ...args], { cwd, env: gitSpawnEnv(AUTHOR), stdout: 'pipe', stderr: 'pipe' })
  if (p.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${p.stderr.toString()}`)
  return p.stdout.toString().trim()
}

export function put(repo: string, rel: string, text = rel): void {
  assertTemp(repo)
  const f = join(repo, rel)
  mkdirSync(join(f, '..'), { recursive: true })
  writeFileSync(f, text)
}

/** A bare origin with `main` pushed and a clone of it, on branch `main`, with one commit. */
export function originWithClone(root: string, name: string): { origin: string; repo: string } {
  const origin = join(root, `${name}-origin.git`)
  const repo = join(root, name)
  mkdirSync(root, { recursive: true })
  gitSync(root, 'init', '--bare', '-b', 'main', origin)
  gitSync(root, 'clone', origin, repo)
  put(repo, 'README.md', '# x')
  put(repo, 'packages/server/server/a.ts', 'export {}')
  gitSync(repo, 'add', '-A'); gitSync(repo, 'commit', '-m', 'init'); gitSync(repo, 'branch', '-M', 'main'); gitSync(repo, 'push', '-u', 'origin', 'main')
  return { origin, repo }
}
