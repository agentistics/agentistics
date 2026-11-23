/**
 * precommit.ts — the pre-commit hook: an incremental typecheck plus the tests the staged change
 * touches (`affected-tests.ts` decides which). The FULL suite runs in CI and at the integration
 * before every release; a WIP commit may skip this with `--no-verify`, the final one must not.
 * A failed test run gets ONE isolated retry of only its failed files (`precommit-retry.ts` decides);
 * typecheck failures and anything not attributable to a test file fail at once.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { needsTypecheck, parseSlowList, selectTests, isTestFile } from './affected-tests'
import { runWithRetry } from './precommit-retry'

const ROOT = join(import.meta.dir, '..')

function sh(cmd: string, args: string[]): { code: number; out: string } {
  const r = spawnSync(cmd, args, { cwd: ROOT, encoding: 'utf8' })
  return { code: r.status ?? 1, out: r.stdout ?? '' }
}

function run(cmd: string, args: string[]): number {
  return spawnSync(cmd, args, { cwd: ROOT, stdio: 'inherit' }).status ?? 1
}

function listTests(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(join(ROOT, dir))) {
    if (name === 'node_modules' || name.startsWith('.') || name === 'dist' || name === 'release') continue
    const rel = dir === '' ? name : `${dir}/${name}`
    const st = statSync(join(ROOT, rel))
    if (st.isDirectory()) listTests(rel, out)
    else if (isTestFile(rel)) out.push(rel)
  }
  return out
}

// node_modules always exists here (deps installed) and Bun does not create the outfile's directory.
const JUNIT = join(ROOT, 'node_modules', '.precommit-junit.xml')

const TAIL_BYTES = 64 * 1024

/** Where `tee` keeps the console of the full run (Bun prints its summary there). */
const CONSOLE = join(ROOT, 'node_modules', '.precommit-console.log')

/**
 * `bun test <args>`, streamed to this terminal as before, keeping the last TAIL_BYTES of its output.
 * It goes through the existing `run` spawn and `tee`: delivery doors.lint pins every spawn/writer site in the repo.
 */
function runCaptured(args: string[], startedAt: number): { code: number; tail: string } {
  const code = run('bash', ['-o', 'pipefail', '-c', 'bun test "$@" 2>&1 | tee "$0"', CONSOLE, ...args])
  const fresh = existsSync(CONSOLE) && statSync(CONSOLE).mtimeMs >= startedAt - 1000
  return { code, tail: fresh ? readFileSync(CONSOLE, 'utf8').slice(-TAIL_BYTES) : '' }
}

/** `bun test <args>` with a JUnit report; a failure earns one isolated retry (precommit-retry.ts). */
async function runTests(args: string[]): Promise<boolean> {
  // No raw writer here (delivery doors.lint pins every one): Bun writes the report; a report older than this run is stale.
  const startedAt = Date.now()
  const first = runCaptured([...args, '--reporter=junit', `--reporter-outfile=${JUNIT}`], startedAt)
  const report = existsSync(JUNIT) && statSync(JUNIT).mtimeMs >= startedAt - 1000 ? readFileSync(JUNIT, 'utf8') : null
  const { ok } = runWithRetry({ code: first.code, report, console: first.tail }, {
    runTests: a => run('bun', ['test', ...a]),
    log: line => console.log(line),
  })
  return ok
}

const staged = sh('git', ['diff', '--cached', '--name-only', '--diff-filter=ACMR']).out.split('\n').filter(Boolean)
if (staged.length === 0) process.exit(0)

const t0 = Date.now()
let failed = false

if (needsTypecheck(staged)) {
  console.log('[pre-commit] typecheck (incremental)…')
  const tsc = run('bun', ['tsc', '--noEmit', '--incremental', '--tsBuildInfoFile', 'node_modules/.cache/precommit.tsbuildinfo'])
  if (tsc !== 0) failed = true
} else {
  console.log('[pre-commit] no code staged — typecheck skipped')
}

if (!failed) {
  let slow = new Set<string>()
  try { slow = parseSlowList(readFileSync(join(ROOT, 'scripts/slow-tests.txt'), 'utf8')) } catch { /* no slow list */ }
  const sel = selectTests(staged, listTests(''), slow)
  console.log(`[pre-commit] tests: ${sel.reason}`)
  if (sel.mode === 'full') {
    // Plain `bun test`, not an explicit file list: a list changes the run order and surfaced
    // cross-file interference that the real suite does not have. Shared code earns the full run.
    if (!(await runTests([]))) failed = true
  } else if (sel.mode === 'files') {
    if (!(await runTests(sel.files.map(f => `./${f}`)))) failed = true
  }
}

console.log(`[pre-commit] ${failed ? 'FAILED' : 'ok'} in ${((Date.now() - t0) / 1000).toFixed(1)}s`)
process.exit(failed ? 1 : 0)
