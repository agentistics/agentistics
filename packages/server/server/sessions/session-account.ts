/**
 * session-account.ts — PURE. Which account a session's process runs on NOW (CONTA.IDENTIDADE).
 *
 * Every attach / reopen / restart / switch-account mints a NEW managed row for the SAME conversation
 * and leaves the older ones in the registry, each still carrying the account IT ran on. So "the
 * account of conversation X" has several answers in the registry, and only one of them is true:
 * the row of the process running now. Readers used to pick their own — the first row with that
 * conversation id (`managedAccountOf`), the last one in file order (`sampleLivePlanSessions`), the
 * first plan meter of the harness (the composer chip) — and three surfaces named three accounts for
 * one session. This module is the ONE rule they all go through:
 *
 *   1. an exact row id wins — the row IS the process;
 *   2. otherwise, among the rows of that conversation, a LIVE one (no `endedAt`) beats an ended one,
 *      and the newer `createdAt` beats the older — a restart in another account is the newest row;
 *   3. the row's own `accountId` (through the registry's aliases) is the answer;
 *   4. a row with none runs in the harness's DEFAULT home, whose account is the one bound to it
 *      (`fallbackSessionAccount`) — never a guess between two visible accounts.
 */
import type { HarnessId } from '@agentistics/core'
import type { AccountsFile } from '../harness-accounts'

/** The part of the account registry this rule reads. */
export type AccountRegistryView = Pick<AccountsFile, 'accounts' | 'bindings'> & Partial<Pick<AccountsFile, 'aliases'>>

export interface SessionAccountRow {
  id: string
  harness?: string
  conversationId?: string
  accountId?: string
  endedAt?: string
  createdAt?: string
}

export interface SessionAccountRef {
  /** A managed row id. */
  id?: string
  /** A conversation id (the harness's own, as the store keys it). */
  conversationId?: string
}

const at = (iso: string | undefined): number => {
  const t = iso ? Date.parse(iso) : NaN
  return Number.isFinite(t) ? t : -Infinity
}

/** The managed row whose process speaks for `ref` now — see the module header. */
export function sessionAccountRow<T extends SessionAccountRow>(rows: readonly T[], ref: SessionAccountRef): T | undefined {
  if (ref.id) {
    const exact = rows.find(r => r.id === ref.id)
    if (exact) return exact
  }
  if (!ref.conversationId) return undefined
  let best: T | undefined
  let bestIdx = -1
  rows.forEach((r, i) => {
    if (r.conversationId !== ref.conversationId) return
    if (!best) { best = r; bestIdx = i; return }
    const liveR = !r.endedAt, liveB = !best.endedAt
    if (liveR !== liveB) { if (liveR) { best = r; bestIdx = i } return }
    const tr = at(r.createdAt), tb = at(best.createdAt)
    if (tr > tb || (tr === tb && i > bestIdx)) { best = r; bestIdx = i }
  })
  return best
}

/** Follows the registry's merged-login aliases to the surviving id. */
export function canonicalId(registry: Partial<Pick<AccountsFile, 'aliases'>> | undefined, id: string): string {
  let cur = id
  for (let i = 0; i < 8 && registry?.aliases?.[cur]; i++) cur = registry.aliases[cur]!
  return cur
}

/**
 * The account of the harness's DEFAULT home: the one bound to it, unless that binding names a hidden
 * or retired account while exactly one other is visible; with no binding, the only visible account.
 */
export function fallbackSessionAccount(harness: HarnessId, registry: Pick<AccountsFile, 'accounts' | 'bindings'>, visible: readonly string[]): string | undefined {
  const bound = registry.bindings[`${harness}:`]
  // A default binding that points at a hidden or retired account must not swallow default-home
  // sessions while exactly one other account is the visible one.
  const boundGone = bound !== undefined && registry.accounts.some(a => a.id === bound && (!a.available || a.retired))
  if (bound && !(boundGone && visible.length === 1)) return bound
  return visible.length === 1 ? visible[0] : undefined
}

/**
 * The account `ref` runs on now. Without a `registry` only rule 3 applies (the row's own id, as
 * stored); with one, aliases are followed and a row with no account falls back to the default home's.
 * No managed row → `undefined`: a process agentop did not start is attributed elsewhere (by path).
 */
export function resolveSessionAccount(
  rows: readonly SessionAccountRow[],
  ref: SessionAccountRef,
  registry?: AccountRegistryView,
): string | undefined {
  const row = sessionAccountRow(rows, ref)
  if (!row) return undefined
  if (row.accountId) return registry ? canonicalId(registry, row.accountId) : row.accountId
  if (!registry || !row.harness) return undefined
  const harness = row.harness as HarnessId
  const visible = registry.accounts.filter(a => a.harness === harness && a.available && !a.retired).map(a => a.id)
  const id = fallbackSessionAccount(harness, registry, visible)
  return id ? canonicalId(registry, id) : undefined
}
