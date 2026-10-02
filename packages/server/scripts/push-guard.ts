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
