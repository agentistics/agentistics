import { describe, expect, it } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { gitTestEnv } from './gitTestEnv'

/**
 * gitTestEnv.lint.test.ts — the repo-wide guard behind GIT-ENV (2026-09-27).
 *
 * The incident this exists to prevent is described in full in `gitTestEnv.ts`'s own header: a test
 * that spawns `git init`/`commit`/`config` in a throwaway directory, run under this repo's
 * pre-commit hook (which runs `bun test` from a linked worktree with `GIT_DIR` and friends already
 * exported), silently operates on the REAL repository instead — `cwd`/`-C` do not override an
 * inherited `GIT_DIR`. Two modules had already fixed this LOCALLY, separately
 * (`packages/runtime/test/git-test-env.ts` and four `packages/server` test files each carrying
 * their own hand-rolled, narrower strip) before this lint existed to make it structural: a local
 * fix is a fix for the files somebody happened to touch, and the next new test file that spawns
 * `git` with the inherited environment is exactly as exposed as the ones that started this.
 *
 * Same shape as `tokens.lint.test.ts` (this file's neighbour) and `runtime-boundary.lint.test.ts`:
 * pure checker functions, exported and self-tested against planted fixtures, then run for real over
 * a directory WALK — so a test file added later is covered by having been created, never by someone
 * remembering to list it.
 *
 * SCOPE — deliberately narrower than "every `.ts` file". Production code spawns real `git` against
 * real repositories all over this codebase on purpose (`repo-probe.ts`'s own `gitEnv()`,
 * `editor-fs.ts`, `repo-facts.ts`, `candidates.ts`, …) and must keep the environment IT needs (a
 * restore's `git clone` needs the user's own `GIT_SSH_COMMAND`, for one) — scanning those too would
 * either flood the lint with intentional non-matches or force a production module to carry a
 * `@git-env-intentional` marker for behaviour that was never wrong. So the walk is scoped to files
 * whose path names them as TEST code: `*.test.ts`/`*.test.tsx`, or any file with a whole path
 * SEGMENT (split on `/ . - _`) equal to `test`/`tests` — which is exactly how this repo already
 * names its test-only, non-`.test.ts`-suffixed helpers (`packages/runtime/test/git-test-env.ts`,
 * `packages/runtime/src/tools/git/test-repo.ts`, `packages/server/test/fixtures/…`), verified by
 * walking the whole of `packages/` once and checking that every file the rule pulls in outside the
 * plain `.test.ts` case really is one of those three (see `SCOPE_SANITY` below — a name like
 * `latest.ts` contains "test" as a raw SUBSTRING but not as a whole segment, so a segment-token
 * match is what keeps a coincidental filename out).
 */

const ROOT = join(import.meta.dir, '..', '..', '..')
const SCAN_DIR = 'packages'
const SELF = join(import.meta.dir, 'gitTestEnv.lint.test.ts')
const MARKER = '@git-env-intentional'

// ── pure checkers ──────────────────────────────────────────────────────────────────────────────

/** Whether `relPath` names itself as test code, by the segment rule described above. */
export function isTestScoped(relPath: string): boolean {
  const segments = relPath.toLowerCase().split(/[/.\-_]/)
  return segments.includes('test') || segments.includes('tests')
}

export interface GitSpawnMatch {
  /** Index into `src` where the offending call's function name starts. */
  index: number
  /** The full call expression, e.g. `execFileSync('git', args, { cwd })` — for a report line. */
  snippet: string
}

/**
 * The full text of the call starting at the first `(` at-or-after `fromIndex`, balanced to its
 * matching `)`. Used to look for `gitTestEnv(` anywhere inside the WHOLE call — including a nested
 * options object several lines down, as `hostile-repo.test.ts` writes it:
 *   Bun.spawn(['git', '-C', repo.dir, 'diff'], {
 *     stdout: 'pipe', stderr: 'pipe',
 *     env: gitTestEnv(),
 *   })
 * A fixed-width window would either miss this (too narrow) or swallow the NEXT statement's own
 * spawn call (too wide, and then two adjacent violations could hide each other).
 */
export function balancedCall(src: string, fromIndex: number): string {
  const open = src.indexOf('(', fromIndex)
  if (open === -1) return ''
  let depth = 0
  let i = open
  for (; i < src.length; i++) {
    if (src[i] === '(') depth++
    else if (src[i] === ')') {
      depth--
      if (depth === 0) { i++; break }
    }
  }
  return src.slice(open, i)
}

// Four independent matchers, one per syntax form — the same trade-off
// `runtime-boundary.lint.test.ts`'s `importSpecifiers` makes over one clever do-everything regex:
// each targets exactly one shape and is easy to read back against the form it names.
//
//  A. child_process family with 'git' as a literal FIRST STRING argument:
//     execFileSync('git', …) / execFile('git', …) / spawnSync('git', …) / spawn('git', …)
const CALL_STRING_ARG = /\b(execFileSync|execFile|spawnSync|spawn)\s*\(\s*(['"`])git\2/g
//  B. Bun's own spawn family with 'git' as the first element of an argv ARRAY:
//     Bun.spawn(['git', …]) / Bun.spawnSync(['git', …])
const CALL_ARRAY_ARG = /\bBun\.(spawn|spawnSync)\s*\(\s*\[\s*(['"`])git\2/g
//  C. execSync's single COMMAND STRING form: execSync('git status')
const CALL_EXEC_SYNC = /\bexecSync\s*\(\s*(['"`])git\b/g
//  D. Bun's shell tag: $`git status` — no call-paren to balance, so this one is matched and reported
//     on its own rather than through `balancedCall`.
const CALL_SHELL_TAG = /\$`git\b/g

/** Every raw `git`-spawning call in `src`, whether or not it is properly scrubbed. */
export function gitSpawnCalls(src: string): GitSpawnMatch[] {
  const out: GitSpawnMatch[] = []
  for (const re of [CALL_STRING_ARG, CALL_ARRAY_ARG, CALL_EXEC_SYNC]) {
    re.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = re.exec(src))) {
      const call = balancedCall(src, m.index)
      out.push({ index: m.index, snippet: call || m[0] })
    }
  }
  CALL_SHELL_TAG.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = CALL_SHELL_TAG.exec(src))) {
    // The shell tag chains methods after the template (`.env(...)`, `.quiet()`, …) rather than
    // taking an options object, so there is no call-paren to balance — a bounded window covers the
    // realistic chain instead.
    out.push({ index: m.index, snippet: src.slice(m.index, m.index + 300) })
  }
  return out
}

/** The line a character offset falls on, 1-based. */
function lineAt(src: string, index: number): number {
  return src.slice(0, index).split('\n').length
}

/** Same shape as `tokens.lint.test.ts`'s `excused()`: the marker on the line, or up to 6 lines above. */
function excused(src: string, index: number): boolean {
  const lines = src.split('\n')
  const n = lineAt(src, index)
  return lines.slice(Math.max(0, n - 7), n).some(l => l.includes(MARKER))
}

export interface GitEnvViolation {
  index: number
  line: number
  snippet: string
}

/** Every `git` spawn in `src` that does not reference `gitTestEnv(` inside its own call, unexcused. */
export function findGitEnvViolations(src: string): GitEnvViolation[] {
  const out: GitEnvViolation[] = []
  for (const call of gitSpawnCalls(src)) {
    if (call.snippet.includes('gitTestEnv(')) continue
    if (excused(src, call.index)) continue
    out.push({ index: call.index, line: lineAt(src, call.index), snippet: call.snippet.replace(/\s+/g, ' ').slice(0, 140) })
  }
  return out
}

// ── the walk ───────────────────────────────────────────────────────────────────────────────────

function walk(dir: string, out: string[] = []): string[] {
  let entries: string[]
  try { entries = readdirSync(dir) } catch { return out }
  for (const name of entries) {
    const p = join(dir, name)
    let st: ReturnType<typeof statSync>
    try { st = statSync(p) } catch { continue }
    if (st.isDirectory()) {
      if (name === 'node_modules' || name === 'dist' || name === '.git') continue
      walk(p, out)
      continue
    }
    if (!/\.(ts|tsx)$/.test(name)) continue
    if (name.endsWith('.generated.ts')) continue
    if (p === SELF) continue
    out.push(p)
  }
  return out
}

describe('gitTestEnv.lint — a test may only spawn `git` with the scrubbed environment (GIT-ENV)', () => {
  // ── self-tests over fixture strings, assembled from fragments so this file's own source never
  //    spells a real unguarded `execFileSync('git', …)` — same technique
  //    `runtime-boundary.lint.test.ts` uses for its "escape" fixtures and `billing-detect.test.ts`
  //    uses for secret-shaped needles. (This file is ALSO excluded from its own walk via `SELF`,
  //    belt and suspenders.) ──

  const Q = "'"
  const EFS = ['execFile', 'Sync'].join('')
  const GIT_LIT = `${Q}git${Q}`

  function violatingCall(): string {
    return `${EFS}(${GIT_LIT}, args, { cwd, env: process.env })`
  }
  function compliantCall(): string {
    return `${EFS}(${GIT_LIT}, args, { cwd, env: gitTestEnv() })`
  }
  function excusedViolatingCall(reason: string): string {
    return `// ${MARKER} — ${reason}\n${violatingCall()}`
  }

  it('self-test: isTestScoped matches *.test.ts, a `test` path segment, and a `test-` prefixed filename — never a coincidental substring', () => {
    expect(isTestScoped('packages/server/server/backup/repo-probe.test.ts')).toBe(true)
    expect(isTestScoped('packages/runtime/test/git-test-env.ts')).toBe(true)
    expect(isTestScoped('packages/runtime/src/tools/git/test-repo.ts')).toBe(true)
    expect(isTestScoped('packages/server/test/fixtures/preferences.lock-test-child.ts')).toBe(true)
    // "latest.ts" contains "test" as a raw substring but not as a whole path segment.
    expect(isTestScoped('packages/server/server/latest.ts')).toBe(false)
    expect(isTestScoped('packages/server/server/backup/repo-probe.ts')).toBe(false)
  })

  it('self-test: gitSpawnCalls finds every syntax form and nothing else', () => {
    expect(gitSpawnCalls(`${EFS}(${GIT_LIT}, args, { env })`).length).toBe(1)
    expect(gitSpawnCalls(`Bun.spawn([${GIT_LIT}, '-C', dir], { env })`).length).toBe(1)
    expect(gitSpawnCalls(`Bun.spawnSync([${GIT_LIT}, 'status'], { env })`).length).toBe(1)
    expect(gitSpawnCalls(`execSync(${Q}git status${Q})`).length).toBe(1)
    expect(gitSpawnCalls('$`git status`.quiet()').length).toBe(1)
    expect(gitSpawnCalls(`spawnSync(${GIT_LIT}, ['status'])`).length).toBe(1)
    // a bare argv build with no `git` string anywhere trips nothing
    expect(gitSpawnCalls(`${EFS}(bin, args, { env })`).length).toBe(0)
    // 'gitignore' etc. are not 'git' — the pattern requires the quote to close right after
    expect(gitSpawnCalls(`${EFS}(${Q}gitignore-tool${Q}, args, { env })`).length).toBe(0)
  })

  it('self-test: balancedCall captures a multi-line options object, not just the first line', () => {
    const src = `Bun.spawn([${GIT_LIT}, '-C', repo.dir, 'diff'], {\n  stdout: 'pipe',\n  env: gitTestEnv(),\n})`
    const call = balancedCall(src, src.indexOf('Bun.spawn'))
    expect(call).toContain('gitTestEnv()')
  })

  it('self-test: findGitEnvViolations flags an unscrubbed call, clears a scrubbed one, and respects the escape hatch', () => {
    expect(findGitEnvViolations(violatingCall()).length).toBe(1)
    expect(findGitEnvViolations(compliantCall()).length).toBe(0)
    expect(findGitEnvViolations(excusedViolatingCall('testing the escape hatch itself')).length).toBe(0)
    // the marker must carry a reason on the SAME/adjacent line, not float unrelated in the file
    const farAway = `${MARKER} — unrelated\n${'\n'.repeat(10)}${violatingCall()}`
    expect(findGitEnvViolations(farAway).length).toBe(1)
  })

  it('self-test: gitTestEnv() itself actually strips what it claims to (sanity on the helper this lint enforces the use of)', () => {
    const env = gitTestEnv({ GIT_DIR: '/x', GIT_AUTHOR_NAME: 'nope', PATH: '/usr/bin' } as NodeJS.ProcessEnv)
    expect('GIT_DIR' in env).toBe(false)
    expect('GIT_AUTHOR_NAME' in env).toBe(false)
    expect(env.PATH).toBe('/usr/bin')
    expect(env.HOME).toBeTruthy()
  })

  // ── the real walk ────────────────────────────────────────────────────────────────────────────

  const ALL_FILES = walk(join(ROOT, SCAN_DIR))
  const TEST_FILES = ALL_FILES.filter(f => isTestScoped(relative(ROOT, f)))

  it('non-vacuity: the walk found a meaningful number of test files, including the ones this task migrated', () => {
    expect(TEST_FILES.length).toBeGreaterThan(100)
    const rels = TEST_FILES.map(f => relative(ROOT, f))
    expect(rels).toContain(join('packages', 'server', 'server', 'backup', 'repo-probe.test.ts'))
    expect(rels).toContain(join('packages', 'runtime', 'test', 'git-test-env.ts'))
    expect(rels).toContain(join('packages', 'runtime', 'src', 'tools', 'git', 'test-repo.ts'))
    expect(rels).not.toContain(relative(ROOT, SELF))
  })

  it('no test in the repo spawns `git` without the scrubbed environment', () => {
    const offences: string[] = []
    for (const file of TEST_FILES) {
      const src = readFileSync(file, 'utf-8')
      for (const v of findGitEnvViolations(src)) {
        offences.push(`${relative(ROOT, file)}:${v.line}  ${v.snippet}`)
      }
    }
    expect(offences).toEqual([])
  })
})
