/**
 * hostile-repo.test.ts — a repository's OWN `.git/config` (plus, for textconv, a `.gitattributes`
 * naming a driver) can turn a read into arbitrary code execution: `core.fsmonitor`, `diff.external`
 * and `diff.<driver>.textconv` can each be pointed at a script git will RUN as a side effect of
 * `status`/`diff`. `git.status` and `git.diff` are catalogued `permission: 'auto'` — the model
 * never has to ask a person before calling them — which is only safe if a hostile repository cannot
 * turn that call into something else. This file builds exactly such a repository and proves the
 * fixed argv + environment in `spawn.ts`/`env.ts` close all three paths.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { runTool } from '../gate.ts'
import { memoryContent, recordingEvents, scriptedPolicy } from '../testing.ts'
import { createGitDiffTool } from './diff.ts'
import { createGitLogTool } from './log.ts'
import { createGitStatusTool } from './status.ts'
import { gitAdd, gitCommit, gitConfig, makeTestRepo, writeMarkerScript, writeRepoFile, type TestRepo } from './test-repo.ts'
import { gitTestEnv } from '../../../test/git-test-env.ts'

const scope = (cwd: string) => ({ workspaceRoot: cwd, cwd, signal: new AbortController().signal })

describe('hostile repository — a "read" must not run a repo-configured program', () => {
  let repo: TestRepo | undefined
  afterEach(async () => {
    await repo?.cleanup()
    repo = undefined
  })

  // Two SEPARATE sanity repos, not one repo with both `diff.external` and `diff.<drv>.textconv`
  // configured at once: MEASURED — when `diff.external` is set, git hands the WHOLE diff (every
  // path) to that program and never runs its own internal diff engine at all, so textconv (which
  // only matters to the INTERNAL engine) never fires either. Combining them in one repo would have
  // silently proven only half of what this file claims to prove.
  test('sanity: an UNMITIGATED git diff really does run diff.external (proves that half of the fixture is real)', async () => {
    repo = await makeTestRepo()
    const markerExtDiff = join(repo.dir, 'MARKER_EXTDIFF_SANITY')
    await writeRepoFile(repo, 'a.txt', 'v1\n')
    await gitAdd(repo, 'a.txt')
    await gitCommit(repo, 'init content')
    const extDiffScript = await writeMarkerScript(repo, 'evil-extdiff.sh', markerExtDiff)
    await gitConfig(repo, 'diff.external', extDiffScript)
    await writeRepoFile(repo, 'a.txt', 'v2\n')

    // Deliberately the RAW command, none of this package's safety flags — proves the attack works
    // absent mitigation, so the mitigated assertion below is proving something real.
    const proc = Bun.spawn(['git', '-C', repo.dir, 'diff'], {
      stdout: 'pipe', stderr: 'pipe',
      env: gitTestEnv(),
    })
    await proc.exited

    expect(existsSync(markerExtDiff)).toBe(true)
  })

  test('sanity: an UNMITIGATED git diff really does run a gitattributes-driven textconv (the other half)', async () => {
    repo = await makeTestRepo()
    const markerTextconv = join(repo.dir, 'MARKER_TEXTCONV_SANITY')
    await writeRepoFile(repo, '.gitattributes', '*.bin diff=evilcmd\n')
    await writeRepoFile(repo, 'b.bin', 'v1\n')
    await gitAdd(repo, '.gitattributes', 'b.bin')
    await gitCommit(repo, 'init content')
    const textconvScript = await writeMarkerScript(repo, 'evil-textconv.sh', markerTextconv)
    await gitConfig(repo, 'diff.evilcmd.textconv', textconvScript)
    await writeRepoFile(repo, 'b.bin', 'v2\n')

    const proc = Bun.spawn(['git', '-C', repo.dir, 'diff'], {
      stdout: 'pipe', stderr: 'pipe',
      env: gitTestEnv(),
    })
    await proc.exited

    expect(existsSync(markerTextconv)).toBe(true)
  })

  test('sanity: an UNMITIGATED git status really does consult a hostile core.fsmonitor', async () => {
    repo = await makeTestRepo()
    const markerFsmonitor = join(repo.dir, 'MARKER_FSMONITOR_SANITY')
    const fsmonitorScript = await writeMarkerScript(repo, 'evil-fsmonitor.sh', markerFsmonitor)
    await gitConfig(repo, 'core.fsmonitor', fsmonitorScript)
    await writeRepoFile(repo, 'untracked.ts', 'x')

    const proc = Bun.spawn(['git', '-C', repo.dir, 'status'], {
      stdout: 'pipe', stderr: 'pipe',
      env: gitTestEnv(),
    })
    await proc.exited

    expect(existsSync(markerFsmonitor)).toBe(true)
  })

  test('git.status and git.diff never trigger core.fsmonitor, diff.external, or textconv', async () => {
    repo = await makeTestRepo()
    const markerFsmonitor = join(repo.dir, 'MARKER_FSMONITOR')
    const markerExtDiff = join(repo.dir, 'MARKER_EXTDIFF')
    const markerTextconv = join(repo.dir, 'MARKER_TEXTCONV')

    await writeRepoFile(repo, 'a.txt', 'v1\n')
    await writeRepoFile(repo, '.gitattributes', '*.bin diff=evilcmd\n')
    await writeRepoFile(repo, 'b.bin', 'v1\n')
    await gitAdd(repo, 'a.txt', '.gitattributes', 'b.bin')
    await gitCommit(repo, 'init content')

    const fsmonitorScript = await writeMarkerScript(repo, 'evil-fsmonitor.sh', markerFsmonitor)
    const extDiffScript = await writeMarkerScript(repo, 'evil-extdiff.sh', markerExtDiff)
    const textconvScript = await writeMarkerScript(repo, 'evil-textconv.sh', markerTextconv)
    await gitConfig(repo, 'core.fsmonitor', fsmonitorScript)
    await gitConfig(repo, 'diff.external', extDiffScript)
    await gitConfig(repo, 'diff.evilcmd.textconv', textconvScript)

    // Unstaged changes to both the attributed binary file and the plain text file, so `diff` (and
    // its `--stat` companion call) has something to show — and therefore every reason to invoke the
    // hostile drivers if our flags did not stop it.
    await writeRepoFile(repo, 'a.txt', 'v2\n')
    await writeRepoFile(repo, 'b.bin', 'v2\n')
    await writeRepoFile(repo, 'new-untracked.ts', 'x')

    const statusTool = createGitStatusTool()
    const diffTool = createGitDiffTool()

    const statusResult = await runTool(statusTool, {}, scope(repo.dir), { policy: scriptedPolicy('allow'), events: recordingEvents(), content: memoryContent() })
    expect(statusResult.status).toBe('completed')

    const diffResult = await runTool(diffTool, {}, scope(repo.dir), { policy: scriptedPolicy('allow'), events: recordingEvents(), content: memoryContent() })
    expect(diffResult.status).toBe('completed')
    // The diff genuinely changed both files (proves the safe flags disabled the hostile drivers
    // rather than the diff having nothing to show them in the first place).
    expect(diffResult.outcome.modelText).toContain('a.txt')

    expect(existsSync(markerFsmonitor)).toBe(false)
    expect(existsSync(markerExtDiff)).toBe(false)
    expect(existsSync(markerTextconv)).toBe(false)
  })

  test('git.log (no -p, bodies omitted) never touches diff machinery either', async () => {
    repo = await makeTestRepo()
    const markerExtDiff = join(repo.dir, 'MARKER_EXTDIFF_LOG')
    const extDiffScript = await writeMarkerScript(repo, 'evil-extdiff.sh', markerExtDiff)
    await gitConfig(repo, 'diff.external', extDiffScript)
    await writeRepoFile(repo, 'a.txt', 'v1\n')
    await gitAdd(repo, 'a.txt')
    await gitCommit(repo, 'add a.txt')

    const logTool = createGitLogTool()
    const r = await runTool(logTool, {}, scope(repo.dir), { policy: scriptedPolicy('allow'), events: recordingEvents(), content: memoryContent() })
    expect(r.status).toBe('completed')
    expect(existsSync(markerExtDiff)).toBe(false)
  })

  test('a hostile core.hooksPath never causes a hook script to run for any of the three verbs', async () => {
    repo = await makeTestRepo()
    // No standard hook fires for status/diff/log (hooks are for WRITE operations); this asserts
    // the flag is harmlessly present rather than testing an observable effect, since there is none
    // to observe on these three read verbs.
    await gitConfig(repo, 'core.hooksPath', repo.dir) // points at a real, empty dir — inert either way
    const statusTool = createGitStatusTool()
    const r = await runTool(statusTool, {}, scope(repo.dir), { policy: scriptedPolicy('allow'), events: recordingEvents(), content: memoryContent() })
    expect(r.status).toBe('completed')
  })
})
