import { execFile, spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { normalizeGitRemote } from '@agentistics/core'
import { gitSpawnEnv } from './git-env'

export interface InclusionProof {
  kind: 'ancestry' | 'patch-id' | 'tree-holds'
  containingCommit: string
}

export interface InclusionInput {
  dir: string
  repoKey: string
  pieceShas: readonly string[]
  target: string
  /** Previous release of this repository; absent: use the piece/target merge-base. */
  previous?: string
}

const HEX = /^[0-9a-f]{7,40}$/
const TIMEOUT = 20_000
const MAX_BUFFER = 48 << 20
const MAX_DIFF = 2 << 20
// No inherited hooks, global diff drivers, textconv or user configuration during a proof.
const env = (extra: Record<string, string> = {}) => gitSpawnEnv({
  GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_NO_REPLACE_OBJECTS: '1', ...extra,
})

function run(dir: string, args: string[], extra: Record<string, string> = {}): Promise<{ ok: boolean; out: string }> {
  return new Promise(resolve => {
    execFile('git', ['-C', dir, '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', '-c', 'core.splitIndex=false', ...args],
      { env: env(extra), timeout: TIMEOUT, maxBuffer: MAX_BUFFER, windowsHide: true },
      (err, out) => resolve({ ok: !err, out: String(out ?? '') }))
  })
}

function stream(dir: string, args: string[], input: string, extra: Record<string, string> = {}): Promise<{ ok: boolean; out: string }> {
  return new Promise(resolve => {
    const p = spawn('git', ['-C', dir, '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', '-c', 'core.splitIndex=false', ...args],
      { env: env(extra), windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] })
    let out = ''
    let overflow = false
    const timer = setTimeout(() => p.kill(), TIMEOUT)
    p.stdout.on('data', d => {
      out += String(d)
      if (out.length > MAX_BUFFER) { overflow = true; p.kill() }
    })
    p.on('error', () => { clearTimeout(timer); resolve({ ok: false, out: '' }) })
    p.on('close', code => { clearTimeout(timer); resolve({ ok: code === 0 && !overflow, out }) })
    p.stdin.on('error', () => {})
    p.stdin.end(input)
  })
}

async function patchIds(dir: string, patch: string): Promise<{ id: string; commit: string }[]> {
  const r = await stream(dir, ['patch-id', '--stable'], patch)
  return r.ok ? r.out.trim().split('\n').filter(Boolean).map(line => {
    const [id, commit] = line.split(' ')
    return { id: id!, commit: commit! }
  }) : []
}

/** Check ALL hunks together against an isolated index, never the checkout or its real index. */
async function treeHolds(dir: string, target: string, diff: string): Promise<boolean> {
  if (!diff.trim() || diff.length > MAX_DIFF) return false
  const tmp = mkdtempSync(join(tmpdir(), 'release-proof-'))
  const extra = { GIT_INDEX_FILE: join(tmp, 'index') }
  try {
    if (!(await run(dir, ['read-tree', target], extra)).ok) return false
    return (await stream(dir, ['apply', '--reverse', '--check', '--cached', '--binary'], diff, extra)).ok
  } finally { rmSync(tmp, { recursive: true, force: true }) }
}

/**
 * Prove inclusion in ONE immutable build. repoKey is the piece's repository identity:
 * normalized origin, or absolute git-common-dir for a local repository without a remote.
 * The legacy wrapper also uses git-common-dir. There is no cross-repository patch cache.
 * All failures (missing objects, invalid ranges, empty/oversized patches) fail closed.
 */
export async function proveInclusion(input: InclusionInput): Promise<InclusionProof | null> {
  const { dir, repoKey, pieceShas, target, previous } = input
  if (!repoKey || !pieceShas.length || !HEX.test(target) || pieceShas.some(s => !HEX.test(s)) || (previous && !HEX.test(previous))) return null
  const common = await run(dir, ['rev-parse', '--path-format=absolute', '--git-common-dir'])
  if (!common.ok) return null
  if (repoKey !== common.out.trim()) {
    const remote = await run(dir, ['config', '--get', 'remote.origin.url'])
    if (!remote.ok || normalizeGitRemote(remote.out) !== repoKey) return null
  }
  const resolve = async (sha: string): Promise<string | null> => {
    const r = await run(dir, ['rev-parse', '--verify', `${sha}^{commit}`])
    return r.ok ? r.out.trim() : null
  }
  const targetSha = await resolve(target)
  const shas = await Promise.all([...new Set(pieceShas)].map(resolve))
  if (!targetSha || shas.some(s => s === null)) return null
  const commits = shas as string[]
  const ancestor = async (a: string, b: string) => (await run(dir, ['merge-base', '--is-ancestor', a, b])).ok
  // A multi-commit piece is ONE combined diff. Do not accept a proof for just one member.
  let tip = commits[0]!
  let first = tip
  for (const sha of commits.slice(1)) {
    if (await ancestor(tip, sha)) tip = sha
    else if (!(await ancestor(sha, tip))) return null
    if (await ancestor(sha, first)) first = sha
  }
  const parent = await resolve(`${first}^`)
  // A root piece starts at the empty tree, including when its last commit has parents.
  const emptyTree = parent ? null : await stream(dir, ['hash-object', '-t', 'tree', '--stdin'], '')
  const base = parent ?? (emptyTree?.ok ? emptyTree.out.trim() : null)
  if (!base) return null
  const own = await run(dir, ['diff', '--binary', '--no-ext-diff', '--no-textconv', base, tip])
  if (!own.ok || !own.out.trim() || own.out.length > MAX_DIFF) return null
  const diffs = [own.out]
  const fork = await run(dir, ['merge-base', tip, targetSha])
  if (commits.length === 1 && fork.ok && fork.out.trim() !== tip) {
    const combined = await run(dir, ['diff', '--binary', '--no-ext-diff', '--no-textconv', fork.out.trim(), tip])
    if (combined.ok && combined.out.trim() && combined.out.length <= MAX_DIFF && combined.out !== own.out) diffs.push(combined.out)
  }
  // Final-tree confirmation is also the revert check, for BOTH ancestry and patch-id.
  const held: string[] = []
  for (const diff of diffs) if (await treeHolds(dir, targetSha, diff)) held.push(diff)
  if (!held.length) return null
  if (await ancestor(tip, targetSha)) return { kind: 'ancestry', containingCommit: tip }

  const start = previous ? await resolve(previous) : (fork.ok ? fork.out.trim() : null)
  if (!start || !(await ancestor(start, targetSha))) return null
  const log = await run(dir, ['log', '--format=commit %H', '-p', '--binary', '--no-ext-diff', '--no-textconv', '--no-merges', `${start}..${targetSha}`])
  if (!log.ok) return null
  const want = new Set<string>()
  for (const diff of held) for (const p of await patchIds(dir, diff)) want.add(p.id)
  for (const p of await patchIds(dir, log.out)) {
    if (want.has(p.id)) return { kind: 'patch-id', containingCommit: p.commit }
  }
  return { kind: 'tree-holds', containingCommit: targetSha }
}
