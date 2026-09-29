/**
 * tools/grant.ts — the token an `allow` verdict becomes. The ONLY module that mints one is
 * `./gate.ts` (`tools-gate.lint.test.ts` asserts `mintGrant` has no other importer), and a tool
 * built by `defineTool` checks the token before it runs. A grant is:
 *
 * - LIVE — registered in a module-private WeakSet, so an object shaped like a grant is not one;
 * - SPENT on use — a grant runs exactly one execution, so it cannot be captured and replayed;
 * - BOUND to its subjects — the tool re-derives its subjects and they must be the ones the policy
 *   saw, so a grant for `read a.ts` cannot run `write b.ts`.
 */

import type { PolicySubject } from './contract.ts'

export interface PolicyGrant {
  readonly toolExecutionId: string
  readonly subjects: readonly PolicySubject[]
}

const live = new WeakSet<object>()

/** Gate-only. */
export function mintGrant(toolExecutionId: string, subjects: readonly PolicySubject[]): PolicyGrant {
  const g: PolicyGrant = Object.freeze({ toolExecutionId, subjects: Object.freeze([...subjects]) })
  live.add(g)
  return g
}

/** Stable, order-sensitive encoding: a tool's subjects are deterministic for its input. */
export function subjectsKey(subjects: readonly PolicySubject[]): string {
  return JSON.stringify(subjects.map(s => Object.keys(s).sort().map(k => [k, (s as Record<string, unknown>)[k]])))
}

/**
 * True, and the grant is SPENT, when `grant` is a live grant for exactly these subjects and this
 * execution. False otherwise — and a false leaves a live grant live (a mismatch is not a use).
 */
export function spendGrant(grant: unknown, toolExecutionId: string, subjects: readonly PolicySubject[]): boolean {
  if (typeof grant !== 'object' || grant === null || !live.has(grant)) return false
  const g = grant as PolicyGrant
  if (g.toolExecutionId !== toolExecutionId) return false
  if (subjectsKey(g.subjects) !== subjectsKey(subjects)) return false
  live.delete(grant)
  return true
}
