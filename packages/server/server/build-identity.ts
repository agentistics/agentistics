/**
 * build-identity.ts — WHICH build this is (ENTREGA.GARANTIDA §4.2). PURE: no slot import, no process
 * spawn here — `scripts/engine-slot.ts` (build time) and `build-info.ts` (run time) inject the git runner.
 *
 * `version` is a label somebody typed; the commit and its tree are what the binary was built FROM. Outside
 * a checkout, or without git, every git-derived field is `null` — never a guessed value and never `''`.
 */
import { normalizeGitRemote } from '@agentistics/core'

export interface BuildIdentity {
  repoKey: string | null
  sha: string | null
  tree: string | null
  builtAt: string
  /** The guarantee slices compiled into this build (spec §2.7). */
  capabilities: string[]
}

/**
 * Guarantee slices compiled in. Each slice that lands adds its id here, in the same commit as the code.
 * S4 itself is identity + ledger, not a guarantee rule, so today the list is empty: a rule that requires a
 * capability must read this list, and an empty list is the honest answer.
 */
export const BUILD_CAPABILITIES: readonly string[] = []

/** Runs `git <args>` in the checkout; returns trimmed stdout, or null on any failure (no git, not a repo). */
export type GitRun = (args: string[]) => string | null

function clean(v: string | null): string | null {
  const t = v?.trim()
  return t ? t : null
}

/** PURE (the runner is injected). */
export function readBuildIdentity(run: GitRun, now: Date, capabilities: readonly string[] = BUILD_CAPABILITIES): BuildIdentity {
  const sha = clean(run(['rev-parse', 'HEAD']))
  // The tree of a commit we could not read is unknowable; never ask for it separately.
  const tree = sha ? clean(run(['rev-parse', 'HEAD^{tree}'])) : null
  const remote = clean(run(['config', '--get', 'remote.origin.url']))
  const repoKey = remote ? clean(normalizeGitRemote(remote)) : null
  return { repoKey, sha, tree, builtAt: now.toISOString(), capabilities: [...capabilities] }
}

/** PURE. A value read from the generated slot is untrusted shape: accept it whole or not at all. */
export function parseSlotBuild(raw: unknown): BuildIdentity | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  const nul = (v: unknown) => v === null || typeof v === 'string'
  if (!nul(o.repoKey) || !nul(o.sha) || !nul(o.tree) || typeof o.builtAt !== 'string') return null
  if (!Array.isArray(o.capabilities) || !o.capabilities.every(c => typeof c === 'string')) return null
  return { repoKey: o.repoKey as string | null, sha: o.sha as string | null, tree: o.tree as string | null, builtAt: o.builtAt, capabilities: [...(o.capabilities as string[])] }
}
