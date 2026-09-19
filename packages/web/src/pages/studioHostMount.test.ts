/**
 * studioHostMount.test.ts — `mountStudioHostPanel`'s own guarantee, asserted against REAL
 * `React.ReactElement` objects rather than against source text or a stand-in component.
 *
 * `panelSlots.mountPanel.test.ts` already proves `mountPanel` itself never reads a `key` out of its
 * props — but only ever against a `Dummy` component it builds by hand, so a `key` slipped into the
 * REAL props object `SessionsPage.tsx` hands to `mountPanel` for `StudioHost` was invisible to it.
 * That is exactly the regression a reviewer planted and the exact gap this file closes: it imports
 * `mountStudioHostPanel` from `SessionsPage.tsx` — the very function that page's own JSX calls — and
 * calls it directly, with no DOM and no jsdom needed, the same way `panelSlots.mountPanel.test.ts`
 * inspects `mountPanel`'s output.
 *
 * See `mountStudioHostPanel`'s own doc comment (`SessionsPage.tsx`) for why the fields it forwards
 * to `mountPanel` are picked EXPLICITLY rather than spread from its params — a `key` added to the
 * params object at the JSX call site is dropped there, before it ever reaches `mountPanel`.
 */
import { describe, expect, test } from 'bun:test'
import { isValidElement } from 'react'
import { mountStudioHostPanel, type StudioHostMountParams } from './SessionsPage'
import { StudioHost } from '../components/sessions/StudioHost'

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

describe('mountStudioHostPanel — the real call site SessionsPage.tsx uses', () => {
  test('shown=false mounts nothing', () => {
    expect(mountStudioHostPanel({ ...BASE, shown: false })).toBeNull()
  })

  test('shown=true returns a real StudioHost element, with no key, carrying the given props', () => {
    const el = mountStudioHostPanel(BASE)
    expect(isValidElement(el)).toBe(true)
    expect(el?.type).toBe(StudioHost)
    expect(el?.key).toBeNull()
    expect(el?.props).toEqual({
      sessionId: 'session-1', lang: 'en', autosave: false, turns: [], onExit: BASE.onExit, target: null,
      harness: undefined, composerMounted: true, onMention: BASE.onMention,
      fullscreen: undefined, onToggleFullscreen: undefined,
    })
  })

  test(
    'a MOVE (only `target` changes, `shown` stays true) yields the same type and the same (null) ' +
    'key — the fact a re-render actually reconciles on, and exactly what the reviewer\'s planted ' +
    '`key={rightIsStudio ? \'right\' : \'bottom\'}` defeated',
    () => {
      const holder = { current: null as unknown }
      const right = mountStudioHostPanel({ ...BASE, target: null })
      const bottom = mountStudioHostPanel({ ...BASE, target: holder as unknown as HTMLElement })
      expect(right?.type).toBe(bottom?.type)
      expect(right?.key).toBe(bottom?.key)
      expect(right?.key).toBeNull()
    },
  )

  test('a `key` field on the PARAMS object (the call site\'s own argument) is dropped, never reaching the element', () => {
    // The explicit field-pick inside `mountStudioHostPanel` is what makes this impossible by
    // construction rather than merely caught after the fact — see its own doc comment.
    const withStrayKey = { ...BASE, key: 'right' } as StudioHostMountParams & { key: string }
    const el = mountStudioHostPanel(withStrayKey)
    expect(el?.key).toBeNull()
  })
})
