/**
 * S2a — the `GuardContext` call-site lint (spec §2.5, review r2 N7 "staged tightening").
 *
 * The context is an OPTIONAL parameter in S2a: the runtime already fails closed (no context + a rank raise = `GuardRefused`),
 * so a forgotten argument is never an unauthorized write — but it IS a door that will refuse a legitimate move once the
 * guarantee is on. This lint lists every call site of the guarded writers that does NOT pass a context, against a SHRINKING
 * ALLOWLIST that may only lose entries:
 *   - a NEW call site without a context fails the build;
 *   - an allowlisted site that now passes one (or is gone) also fails, until the allowlist entry is removed — so the list only
 *     ever gets shorter. S2c empties it and makes the parameter required, and the compiler becomes the inventory.
 *
 * Guarded writers: the task store's `upsertTask` / `patchTask` / `upsertSubtask` / `registerComposerSubtask` (they can change
 * a status or the CI signal, so they can raise a rank) and the delivery store's `update` (it can change a phase).
 * `guardCount` is "calls carrying a context" and is asserted to be non-zero so the scanner cannot rot into seeing nothing.
 */
import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { productionSources, read } from './lint-scan.testing'
import { carryingContext, missingContext } from './guard-sites.testing'

const PKG = join(import.meta.dir, '..', '..')

/** file → how many guarded-writer calls in it carry NO context. May only SHRINK. */
const ALLOWLIST: Readonly<Record<string, number>> = {
  // `service.ts`: every `d.store.update` there is wrapped at construction by `createDeliveryService` with the flow's own
  // context (the tick, the reconcile and adoption speak as `flow:*`), so none of them is unguarded; S2c names each one.
  'server/delivery/service.ts': 57,
  'server/flows/composer-task.ts': 1,
  'server/harness-accounts.ts': 1,
  'server/sessions/auto-switch-io.ts': 6,
  'server/sessions/cli-session.ts': 1,
  'server/sessions/review-clean.ts': 2,
  'server/sessions/task-source.ts': 2,
  'server/sessions/task-web.ts': 12,
}

describe('GuardContext call sites (shrinking allowlist)', () => {
  const files = productionSources(PKG, PKG)
  const actual: Record<string, number> = {}
  let carrying = 0
  for (const rel of files) { const s = read(PKG, rel); const n = missingContext(s); if (n) actual[rel] = n; carrying += carryingContext(s) }

  test('no call site is missing a context that is not on the allowlist, and the allowlist only shrinks', () => {
    const grew = Object.entries(actual).filter(([f, n]) => n > (ALLOWLIST[f] ?? 0)).map(([f, n]) => `${f}: ${n} call(s) without a context (allowed ${ALLOWLIST[f] ?? 0})`)
    const stale = Object.entries(ALLOWLIST).filter(([f, n]) => (actual[f] ?? 0) < n).map(([f, n]) => `${f}: allowlisted ${n} but only ${actual[f] ?? 0} left — lower the entry`)
    expect({ grew, stale }).toEqual({ grew: [], stale: [] })
  })

  test('the scanner sees the doors this slice already threads (so it cannot rot into seeing nothing)', () => {
    expect(carrying).toBeGreaterThanOrEqual(4)
  })

  test('a mutant call site is caught', () => {
    expect(missingContext(`await w.store.upsertSubtask({ ...s, status: 'in_review' })`)).toBe(1)
    expect(missingContext(`await w.store.upsertSubtask({ ...s }, guard)`)).toBe(0)
    expect(missingContext(`await w.store.patchTask(id, { status }, { allowOpenSubtasks: true })`)).toBe(1)
    expect(missingContext(`await w.store.patchTask(id, { status }, { guard: o.guard })`)).toBe(0)
    expect(missingContext(`await d.store.update(doc => { doc.x = 1 })`)).toBe(1)
    expect(missingContext(`await d.store.update(doc => {}, { guard: flowContext() })`)).toBe(0)
    expect(missingContext(`// w.store.upsertSubtask(x)\nconst s = "store.update(x)"`)).toBe(0)
  })
})
