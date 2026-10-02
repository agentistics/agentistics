// pre-push IO: git's stdin ranges → `evaluatePush`. Quiet on success; on failure only the offences.
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { parseFrozenList, parseNameStatus } from './frozen-paths'
import { evaluatePush, parsePushLines, type GitRun } from './push-guard'

const root = join(import.meta.dir, '..', '..', '..')
const runner = (cwd: string): GitRun => args => {
  const r = Bun.spawnSync(['git', ...args], { cwd })
  return { code: r.exitCode, out: r.stdout.toString() }
}
const engineDir = process.env.AGENTISTICS_ENGINE_CLONE ?? join(homedir(), 'agentistics-engine')
const ev = evaluatePush(parsePushLines(await Bun.stdin.text()), {
  frozen: parseFrozenList(readFileSync(join(root, '.github/frozen-engine-paths.txt'), 'utf8')),
  git: runner(root),
  engineGit: existsSync(join(engineDir, '.git')) ? runner(engineDir) : undefined,
  checkRemote: true,
}, parseNameStatus)
if (!ev.ok) {
  console.error(`push refused — engine code must not reach the public repo:\n${ev.lines.join('\n')}`)
  process.exit(1)
}
