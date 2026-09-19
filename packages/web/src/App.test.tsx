/**
 * App.tsx has no test file of its own — a "thousand-line component" per its own comment on the
 * Studio button block. What is tested here is exactly what the slots/references design requires and
 * nothing else: the first-open dot's own pure persistence functions, which still live in App.tsx —
 * pulled out precisely so they can be asserted without clicking through the whole page in a browser
 * (this repo has no jsdom and no `@testing-library/react`, so a click cannot be simulated and
 * `useEffect` never runs under `renderToStaticMarkup` — the same constraint `Studio.test.tsx`
 * documents).
 *
 * A fix-wave review planted six defects that left the whole web suite green with the button's
 * contract entirely unguarded (see that review's I1). Two of the six live here:
 *
 *   - the `try/catch` around `localStorage.getItem` removed            — covered below
 *   - the `try/catch` around `localStorage.setItem` removed            — covered below
 *
 * The THIRD (`aria-pressed={studioOn} → aria-pressed({false})`) used to live here too, against
 * `SessionHeaderSwitcher` — App.tsx's own render of the panel switcher, back when it was the FIXED
 * HEADER's tab group. This pass (design item 1/2, owner's drawing: "the top bar becomes clean and
 * dedicated to the title etc") moves that whole switcher DOWN into the bottom band, merging it with
 * the band's own former occupant segment — so the component is gone from App.tsx entirely and its
 * markup coverage moved with it, to `bandControls.test.tsx`'s own `PanelBar` section, next to the
 * component it now tests.
 */
import { expect, test } from 'bun:test'
import { readStudioSeen, STUDIO_SEEN_KEY, writeStudioSeen } from './App'

// --- readStudioSeen / writeStudioSeen: the dot's own persistence, and the private-mode floor -------

test('readStudioSeen answers false before anything has been written', () => {
  const store = new Map<string, string>()
  expect(readStudioSeen({ getItem: k => store.get(k) ?? null })).toBe(false)
})

test('readStudioSeen answers true once the flag has actually been written', () => {
  const store = new Map<string, string>([[STUDIO_SEEN_KEY, '1']])
  expect(readStudioSeen({ getItem: k => store.get(k) ?? null })).toBe(true)
})

/** Plant: drop the `try/catch` in `readStudioSeen`. A throwing `getItem` then propagates out of this
 *  call instead of being tolerated, and this assertion never gets to run. */
test('readStudioSeen tolerates a throwing getItem, answering not-seen rather than crashing', () => {
  const throwing = { getItem: () => { throw new Error('SecurityError: denied') } }
  expect(readStudioSeen(throwing)).toBe(false)
})

test('writeStudioSeen actually persists the flag when storage cooperates', () => {
  const store = new Map<string, string>()
  writeStudioSeen({ setItem: (k, v) => { store.set(k, v) } })
  expect(store.get(STUDIO_SEEN_KEY)).toBe('1')
})

/** Plant: drop the `try/catch` in `writeStudioSeen`. A throwing `setItem` then propagates and this
 *  `not.toThrow()` fails. */
test('writeStudioSeen tolerates a throwing setItem, never throwing itself', () => {
  const throwing = { setItem: () => { throw new Error('SecurityError: denied') } }
  expect(() => writeStudioSeen(throwing)).not.toThrow()
})
