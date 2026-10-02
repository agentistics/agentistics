// pre-push IO: reads git's stdin ranges, diffs each, applies `push-guard.ts`. Exit 1 refuses.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseFrozenList, parseNameStatus } from './frozen-paths'
import { checkPush, parsePushLines, planRange } from './push-guard'

const root = join(import.meta.dir, '..', '..', '..')
const git = (...a: string[]) => Bun.spawnSync(['git', ...a], { cwd: root })
const frozen = parseFrozenList(readFileSync(join(root, '.github/frozen-engine-paths.txt'), 'utf8'))
const bad: string[] = []

for (const ref of parsePushLines(await Bun.stdin.text())) {
  const plan = planRange(ref)
  if (plan.kind === 'skip') continue
  let base: string
  if (plan.kind === 'new-branch') {
    const mb = git('merge-base', plan.head, plan.against)
    if (mb.exitCode !== 0) { console.error(`push guard: no merge-base with ${plan.against}; fetch origin and retry.`); process.exit(1) }
    base = mb.stdout.toString().trim()
  } else {
    base = plan.base
    // The remote tip may not exist locally (someone else pushed): fall back to main's merge-base.
    if (git('cat-file', '-e', `${base}^{commit}`).exitCode !== 0) {
      base = git('merge-base', plan.head, 'origin/main').stdout.toString().trim()
    }
  }
  const diff = git('diff', '--name-status', '--no-renames', base, plan.head)
  if (diff.exitCode !== 0) { console.error(`push guard: git diff failed: ${diff.stderr.toString().trim()}`); process.exit(1) }
  for (const o of checkPush(parseNameStatus(diff.stdout.toString()), frozen, ref.remoteRef).offences) {
    const c = git('log', '-1', '--format=%h', `${base}..${plan.head}`, '--', o.path).stdout.toString().trim()
    bad.push(`${o.sentence}${c ? ` (commit ${c})` : ''}`)
  }
}
if (bad.length > 0) {
  console.error(`push refused — ${bad.length} engine path(s) in this push:\n${bad.join('\n')}`)
  process.exit(1)
}
