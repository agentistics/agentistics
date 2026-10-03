/**
 * precommit.ts — the pre-commit hook: an incremental typecheck plus the tests the staged change
 * touches (`affected-tests.ts` decides which). The FULL suite runs in CI and at the integration
 * before every release; a WIP commit may skip this with `--no-verify`, the final one must not.
 */
import { spawnSync } from 'node:child_process'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { needsTypecheck, parseSlowList, selectTests, isTestFile } from './affected-tests'

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
    if (run('bun', ['test']) !== 0) failed = true
  } else if (sel.mode === 'files') {
    if (run('bun', ['test', ...sel.files.map(f => `./${f}`)]) !== 0) failed = true
  }
}

console.log(`[pre-commit] ${failed ? 'FAILED' : 'ok'} in ${((Date.now() - t0) / 1000).toFixed(1)}s`)
process.exit(failed ? 1 : 0)
