/**
 * studioHostMountParams.types.test.ts — the TYPE-LEVEL half of I4, enforced by `bun tsc --noEmit`
 * rather than by any runtime assertion.
 *
 * `studioHostMount.test.ts` proves `mountStudioHostPanel`'s own explicit field-picking drops a stray
 * `key` before it ever reaches `mountPanel` — a RUNTIME guarantee, and a strong one, but one that
 * still let a `key` compile at every route into that function. `sessionsPage.lint.test.ts`'s I4
 * block closes the literal at the real JSX call site with a source scan — but a source scan reads
 * TEXT, and the fix-wave-3 re-review measured a shape neither of those two touches at all: a `key`
 * that never appears as a literal field anywhere near the call, because it arrived through an
 * intermediate typed variable or a later spread.
 *
 * `StudioHostMountParams.key: never` (`SessionsPage.tsx`, its own doc comment) is what closes that:
 * naming `key` in the interface turns TypeScript's check on it from "is this an EXCESS property"
 * (which only ever fires on a fresh object literal assigned or passed directly — the exact thing an
 * intermediate variable or a spread stops being) into "is this property's TYPE compatible with
 * `never`" — an ordinary structural check TypeScript performs on every comparison, literal or not.
 * The three cases below are the three shapes fix-wave-3's brief named; each is pinned with
 * `// @ts-expect-error` so `bun tsc --noEmit` fails the build the moment any of them stops erroring
 * — which is exactly what would happen if `key?: never` were ever weakened back to nothing, widened
 * to `key?: unknown`, or removed.
 */
import { expect, test } from 'bun:test'
import type { StudioHostMountParams } from './SessionsPage'

const BASE: StudioHostMountParams = {
  shown: true,
  sessionId: 'session-1',
  lang: 'en',
  autosave: false,
  turns: [],
  onExit: () => {},
  target: null,
  composerMounted: true,
  onMention: () => {},
}

test('shape 1 — a `key` in a direct object literal passed to the params type is a type error', () => {
  // This is the ORIGINAL plant shape (a `key` field written directly into the literal at the real
  // call site) — already caught by plain excess-property checking before `key?: never` existed, and
  // kept here so the three shapes stay together as one guarantee.
  // @ts-expect-error `key` does not exist on `StudioHostMountParams` — see its own `key?: never` field
  const direct: StudioHostMountParams = { ...BASE, key: 'right' }
  expect(direct).toBeTruthy()
})

test('shape 2 — a `key` routed through an intermediate typed variable is STILL a type error', () => {
  // Before `key?: never`, this shape was the hole: `stray` is not a fresh object literal by the time
  // it reaches the `StudioHostMountParams` annotation below, so ordinary excess-property checking
  // (which only inspects FRESH literals) would have let it through silently. `key?: never` does not
  // rely on freshness at all — `stray.key` is the string `'right'`, `never` accepts nothing, so the
  // structural comparison fails at the assignment below regardless of how `stray` was built.
  const stray = { ...BASE, key: 'right' as const }
  // @ts-expect-error `stray.key` is `'right'`, not assignable to `StudioHostMountParams['key']` (`never`)
  const routed: StudioHostMountParams = stray
  expect(routed).toBeTruthy()
})

test('shape 3 — a `key` merged in later via a spread is STILL a type error', () => {
  // The re-review's other named shape: `key` never appears as a literal field of the SAME object
  // literal that also lists `shown`/`sessionId`/etc. — it arrives from a second, separately-typed
  // object spread in after `BASE`. A source scan of "the object literal at the call site" has
  // nothing to find here; `key?: never` still catches it because the spread's own `key` property
  // still has to satisfy `never` once the whole expression is compared against the target type.
  const extra = { key: 'bottom' as const }
  // @ts-expect-error spreading `extra` after `BASE` still carries a `key: 'bottom'`, still rejected
  const spread: StudioHostMountParams = { ...BASE, ...extra }
  expect(spread).toBeTruthy()
})

test('sanity — a params object with no `key` at all keeps type-checking (no false positive)', () => {
  const clean: StudioHostMountParams = { ...BASE, target: null }
  expect(clean.shown).toBe(true)
})
