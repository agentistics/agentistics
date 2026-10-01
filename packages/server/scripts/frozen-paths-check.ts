// CI guard: fail a pull request that touches a path the ENGINE repo now owns.
// Usage: bun packages/server/scripts/frozen-paths-check.ts <base-ref> [head-ref]
// The PR title is read from $PR_TITLE (passed through env, never interpolated into the shell).
// The list is `.github/frozen-engine-paths.txt`; the rule is `frozen-paths.ts`.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { checkFrozen, parseFrozenList, parseNameStatus, ES4_TAG } from './frozen-paths'

const root = join(import.meta.dir, '..', '..', '..')
const base = process.argv[2]
const head = process.argv[3] ?? 'HEAD'
if (!base) {
  console.error('usage: frozen-paths-check.ts <base-ref> [head-ref]')
  process.exit(2)
}

const globs = parseFrozenList(readFileSync(join(root, '.github/frozen-engine-paths.txt'), 'utf8'))
const diff = Bun.spawnSync(['git', 'diff', '--name-status', '--no-renames', base, head], { cwd: root })
if (diff.exitCode !== 0) {
  console.error(`git diff ${base} ${head} failed: ${diff.stderr.toString().trim()}`)
  process.exit(2)
}

const verdict = checkFrozen(parseNameStatus(diff.stdout.toString()), globs, process.env.PR_TITLE ?? '')
if (verdict.ok) {
  if (verdict.deleted.length > 0) console.log(`${ES4_TAG}: ${verdict.deleted.length} frozen path(s) deleted — allowed.`)
  else console.log('No frozen engine paths touched.')
  process.exit(0)
}
for (const v of verdict.violations) console.error(`::error file=${v.path}::${v.sentence}`)
console.error(`\n${verdict.violations.length} frozen path(s) touched. See .github/frozen-engine-paths.txt.`)
process.exit(1)
