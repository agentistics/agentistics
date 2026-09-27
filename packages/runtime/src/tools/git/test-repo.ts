/**
 * tools/git/test-repo.ts — test-support only (no `.test.ts` suffix, so the gate/boundary lints
 * that walk `src/` for offending patterns still see it, and it correctly carries none). Builds
 * FRESH, throwaway git repositories under `os.tmpdir()` for the tools in this directory to run
 * against — never the real repository this worktree lives in, and nothing here is ever committed.
 */

import { mkdtemp, rm, writeFile, mkdir, chmod } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gitTestEnv } from '../../../test/git-test-env.ts'

export interface TestRepo {
  dir: string
  cleanup(): Promise<void>
}

async function runGitRaw(dir: string, args: string[]): Promise<void> {
  const proc = Bun.spawn(['git', '-C', dir, ...args], {
    env: gitTestEnv(),
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [stderr, exitCode] = await Promise.all([new Response(proc.stderr).text(), proc.exited])
  if (exitCode !== 0) throw new Error(`git ${args.join(' ')} failed: ${stderr}`)
}

/** A bare, empty repository with one commit — enough for `git.status`/`git.diff`/`git.log` to answer. */
export async function makeTestRepo(): Promise<TestRepo> {
  const dir = await mkdtemp(join(tmpdir(), 'agentistics-git-tool-'))
  await runGitRaw(dir, ['init', '--initial-branch=main'])
  await runGitRaw(dir, ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '--allow-empty', '-m', 'init'])
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) }
}

/** Writes `content` to `relPath` under `repo.dir`, creating parent directories as needed. */
export async function writeRepoFile(repo: TestRepo, relPath: string, content: string): Promise<void> {
  const full = join(repo.dir, relPath)
  await mkdir(join(full, '..'), { recursive: true })
  await writeFile(full, content, 'utf8')
}

export async function gitAdd(repo: TestRepo, ...paths: string[]): Promise<void> {
  await runGitRaw(repo.dir, ['add', ...paths])
}

export async function gitCommit(repo: TestRepo, message: string): Promise<void> {
  await runGitRaw(repo.dir, ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-m', message])
}

export async function gitConfig(repo: TestRepo, key: string, value: string): Promise<void> {
  await runGitRaw(repo.dir, ['config', key, value])
}

/** Writes an executable shell script at `relPath` (relative to the repo) that appends `marker`'s
 *  existence as a side effect — used by the hostile-repo tests to prove a hook never ran. */
export async function writeMarkerScript(repo: TestRepo, relPath: string, markerAbsPath: string): Promise<string> {
  const scriptAbsPath = join(repo.dir, relPath)
  const script = `#!/bin/sh\ntouch '${markerAbsPath}'\nexit 0\n`
  await writeFile(scriptAbsPath, script, 'utf8')
  await chmod(scriptAbsPath, 0o755)
  return scriptAbsPath
}
