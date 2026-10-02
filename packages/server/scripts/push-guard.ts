// PURE: may this push put engine code on the PUBLIC repository?
//
// The path list is `.github/frozen-engine-paths.txt` (read by the caller, parsed by
// `frozen-paths.ts` — there is no second copy). On top of it sits the ENGINE LAYOUT, the
// directories the engine repo uses and the public one must never hold. `engine.pin` is allowed.
// Deletions are allowed (the ES.4 delete-only case: a push has no PR title, and CI still demands
// the `[ES.4]` tag on the PR itself). An add or modify is refused.

import { isFrozen, type Change } from './frozen-paths'

export const ENGINE_LAYOUT_GLOBS = ['engine/src/**', 'runtime/src/**', 'engine/test/**', 'public.pin'] as const
export const ALLOWED_GLOBS = ['engine.pin'] as const

export const ZERO_SHA = /^0+$/

export interface PushRef { localRef: string; localSha: string; remoteRef: string; remoteSha: string }

/** git's pre-push stdin: `<local ref> <local sha> <remote ref> <remote sha>` per line. */
export function parsePushLines(text: string): PushRef[] {
  const out: PushRef[] = []
  for (const line of text.split('\n')) {
    const p = line.trim().split(/\s+/)
    if (p.length !== 4) continue
    out.push({ localRef: p[0]!, localSha: p[1]!, remoteRef: p[2]!, remoteSha: p[3]! })
  }
  return out
}

export type RangePlan =
  | { kind: 'skip'; why: 'delete' }
  | { kind: 'diff'; base: string; head: string }
  /** A new branch: compare against the merge-base with origin/main, which the caller resolves. */
  | { kind: 'new-branch'; head: string; against: string }

export function planRange(ref: PushRef, mainRef = 'origin/main'): RangePlan {
  if (ZERO_SHA.test(ref.localSha)) return { kind: 'skip', why: 'delete' }
  if (ZERO_SHA.test(ref.remoteSha)) return { kind: 'new-branch', head: ref.localSha, against: mainRef }
  return { kind: 'diff', base: ref.remoteSha, head: ref.localSha }
}

export function isEnginePath(path: string, frozen: readonly string[]): boolean {
  if (isFrozen(path, ALLOWED_GLOBS)) return false
  return isFrozen(path, frozen) || isFrozen(path, ENGINE_LAYOUT_GLOBS)
}

export interface PushOffence { path: string; status: Change['status']; sentence: string }
export interface PushVerdict { ok: boolean; offences: PushOffence[] }

export function checkPush(changes: readonly Change[], frozen: readonly string[], ref = ''): PushVerdict {
  const offences: PushOffence[] = []
  for (const c of changes) {
    if (c.status === 'D' || !isEnginePath(c.path, frozen)) continue
    offences.push({
      path: c.path,
      status: c.status,
      sentence: `${c.path}${ref ? ` (${ref})` : ''}: engine code must never reach the public repo — it belongs in agentistics/agentistics-engine.`,
    })
  }
  return { ok: offences.length === 0, offences }
}

// ── the wider leak check (local hook + detection Action) ─────────────────────────────────

import type { Change as ChangeT } from './frozen-paths'

export const ENGINE_REMOTE_RE = /agentistics-engine/i
export const MAX_REPORT_LINES = 20

/** A remote of the PUBLIC clone that points at the engine repository is itself the leak path. */
export function checkRemotes(remotes: readonly { name: string; url: string }[]): string[] {
  return remotes
    .filter(r => ENGINE_REMOTE_RE.test(r.url))
    .map(r => `remote "${r.name}" points at the engine repo (${r.url}) — remove it from the public clone.`)
}

/** Commits that exist on the engine's main but not on the public main, among the pushed ones. */
export function engineOnlyCommits(pushed: readonly string[], inEngineMain: ReadonlySet<string>, inPublicMain: ReadonlySet<string>): string[] {
  return pushed.filter(sha => inEngineMain.has(sha) && !inPublicMain.has(sha))
}

/** Caps a failure report so it stays readable: at most MAX_REPORT_LINES lines. */
export function capReport(lines: readonly string[]): string[] {
  if (lines.length <= MAX_REPORT_LINES) return [...lines]
  return [...lines.slice(0, MAX_REPORT_LINES - 1), `… and ${lines.length - (MAX_REPORT_LINES - 1)} more.`]
}

export interface GitRun { (args: string[]): { code: number; out: string } }
export interface EvaluateOpts {
  frozen: readonly string[]
  git: GitRun
  /** Engine clone's runner; absent (a contributor) skips the engine-commit check silently. */
  engineGit?: GitRun
  checkRemote?: boolean
  mainRef?: string
}
export interface Hit { path: string; commit: string; ref: string }
export interface Evaluation { ok: boolean; lines: string[]; hits: Hit[] }

/** Ranges → offences. Shared by the hook and the Action; `parse` is frozen-paths' parseNameStatus. */
export function evaluatePush(refs: readonly PushRef[], opts: EvaluateOpts, parse: (t: string) => ChangeT[]): Evaluation {
  const main = opts.mainRef ?? 'origin/main'
  const lines: string[] = []
  const hits: Hit[] = []
  if (opts.checkRemote) {
    const seen = new Map<string, string>()
    for (const l of opts.git(['remote', '-v']).out.split('\n')) {
      const p = l.split(/\s+/)
      if (p.length >= 2 && p[0]) seen.set(p[0], p[1]!)
    }
    lines.push(...checkRemotes([...seen].map(([name, url]) => ({ name, url }))))
  }
  for (const ref of refs) {
    const plan = planRange(ref, main)
    if (plan.kind === 'skip') continue
    let base: string
    if (plan.kind === 'new-branch') {
      const mb = opts.git(['merge-base', plan.head, plan.against])
      if (mb.code !== 0) { lines.push(`no merge-base with ${plan.against}; fetch origin and retry.`); continue }
      base = mb.out.trim()
    } else {
      base = plan.base
      if (opts.git(['cat-file', '-e', `${base}^{commit}`]).code !== 0) base = opts.git(['merge-base', plan.head, main]).out.trim()
    }
    const diff = opts.git(['diff', '--name-status', '--no-renames', base, plan.head])
    if (diff.code !== 0) { lines.push(`git diff failed for ${ref.remoteRef}.`); continue }
    for (const o of checkPush(parse(diff.out), opts.frozen, ref.remoteRef).offences) {
      const commit = opts.git(['log', '-1', '--format=%h', `${base}..${plan.head}`, '--', o.path]).out.trim()
      hits.push({ path: o.path, commit, ref: ref.remoteRef })
      lines.push(`${o.path} (${ref.remoteRef}${commit ? `, commit ${commit}` : ''}) — engine code, belongs in agentistics/agentistics-engine.`)
    }
    if (opts.engineGit) {
      const pushed = opts.git(['rev-list', '--max-count=500', `${base}..${plan.head}`]).out.split('\n').filter(Boolean)
      const inEngine = new Set(pushed.filter(s => opts.engineGit!(['merge-base', '--is-ancestor', s, 'origin/main']).code === 0))
      const inPublic = new Set(pushed.filter(s => opts.git(['merge-base', '--is-ancestor', s, main]).code === 0))
      for (const s of engineOnlyCommits(pushed, inEngine, inPublic)) lines.push(`commit ${s.slice(0, 8)} is on the engine's main but not the public main (${ref.remoteRef}).`)
    }
  }
  return { ok: lines.length === 0, lines: capReport(lines), hits }
}

export const issueTitle = (branch: string) => `Engine paths on public branch ${branch}`

/** Detection, not prevention: the body names what landed where. */
export function issueBody(branch: string, sha: string, hits: readonly Hit[]): string {
  const rows = hits.slice(0, MAX_REPORT_LINES).map(h => `- \`${h.path}\` (commit ${h.commit || sha.slice(0, 8)})`)
  if (hits.length > MAX_REPORT_LINES) rows.push(`- … and ${hits.length - MAX_REPORT_LINES} more.`)
  return [
    `Push \`${sha.slice(0, 8)}\` to branch \`${branch}\` added or modified paths owned by the engine repo.`,
    '',
    ...rows,
    '',
    'This is **detection, not prevention**: GitHub does not allow push rules on a public repository, so the code is already on the remote. Delete the branch (or force-push it clean); the fix belongs in `agentistics/agentistics-engine`.',
  ].join('\n')
}
