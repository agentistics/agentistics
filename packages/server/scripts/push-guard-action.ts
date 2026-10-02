// Detection Action IO: BEFORE/SHA/REF env → offences → exit 1, and the issue body in $ISSUE_BODY_FILE.
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseFrozenList, parseNameStatus } from './frozen-paths'
import { evaluatePush, issueBody, offenceCount } from './push-guard'

const root = join(import.meta.dir, '..', '..', '..')
const { BEFORE = '', SHA = '', REF = '', ISSUE_BODY_FILE, RUN_URL = '' } = process.env
const git = (args: string[]) => {
  const r = Bun.spawnSync(['git', ...args], { cwd: root })
  return { code: r.exitCode, out: r.stdout.toString() }
}
const ev = evaluatePush([{ localRef: REF, localSha: SHA, remoteRef: REF, remoteSha: BEFORE || '0'.repeat(40) }], {
  frozen: parseFrozenList(readFileSync(join(root, '.github/frozen-engine-paths.txt'), 'utf8')),
  git,
  mainRef: 'origin/main',
}, parseNameStatus)
if (ev.ok) { console.log('No engine paths in this push.'); process.exit(0) }
// The run log is public: a count, never a path or a commit.
console.error(`engine-path check failed: ${offenceCount(ev.hits.length)}`)
if (ISSUE_BODY_FILE) writeFileSync(ISSUE_BODY_FILE, issueBody(REF.replace(/^refs\/heads\//, ''), RUN_URL))
process.exit(1)
