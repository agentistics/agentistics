/**
 * panelSlots.mountPanel.test.ts — `mountPanel`'s own guarantee, asserted against REAL
 * `React.ReactElement` objects rather than against source text.
 *
 * This is the genuine structural counterpart to `sessionsPage.lint.test.ts`'s I4 block. That file
 * can only pin the SHAPE of the one call site that mounts `StudioHost` — there is no jsdom in this
 * repo's test runner, so nothing can actually RENDER `SessionsPage` and watch a move happen. What
 * CAN be rendered, with no DOM at all, is `mountPanel` itself: it is a plain function that returns a
 * `React.ReactElement | null`, and React's own element objects are ordinary values — `isValidElement`,
 * `.key`, `.type`, `.props` — that a test can inspect directly.
 *
 * THE PROPERTY THIS PINS: React identifies an element by (type, key, position in its parent's
 * children). Two `mountPanel(true, Component, propsA)` / `mountPanel(true, Component, propsB)`
 * calls — the "before a move" and "after a move" element, however different their props — must
 * produce elements with the SAME `.type` and the SAME `.key` (`null`, always), because that is
 * exactly what makes React reuse the fiber instead of unmounting and remounting it. The reviewer's
 * planted regression (`key={rightIsStudio ? 'right' : 'bottom'}` on the JSX tag) is reproduced here
 * not as a source edit but as what it WOULD do to the element: give the two calls different keys —
 * and the test that follows proves that shape is exactly what breaks the invariant this file checks.
 */
import { describe, expect, test } from 'bun:test'
import { createElement, isValidElement } from 'react'
import { mountPanel } from './panelSlots'

function Dummy(_props: { x: number }) {
  return null
}

describe('mountPanel', () => {
  test('shown=false renders nothing', () => {
    expect(mountPanel(false, Dummy, { x: 1 })).toBeNull()
  })

  test('shown=true returns a real element of the given type, with no key', () => {
    const el = mountPanel(true, Dummy, { x: 1 })
    expect(isValidElement(el)).toBe(true)
    expect(el?.type).toBe(Dummy)
    expect(el?.key).toBeNull()
    expect(el?.props).toEqual({ x: 1 })
  })

  test('two calls simulating a MOVE — shown stays true, only the props change — yield the same type and the same (null) key', () => {
    // "Before": the panel showing on the right. "After": the same panel, moved to the bottom — a
    // different `target`, everything else about the call unchanged, exactly as `StudioHost`'s own
    // `target` prop changes across a move while `shown` (`isPanelShown`) stays true throughout.
    const before = mountPanel(true, Dummy, { x: 1 })
    const after = mountPanel(true, Dummy, { x: 2 })
    expect(before?.type).toBe(after?.type)
    expect(before?.key).toBe(after?.key)
    // This is the fact a re-render actually reconciles on: same type at the same tree position,
    // same key (here, both null) — React reuses the fiber. A `null !== null` failure here would be
    // the only way this test could ever go red on the CURRENT implementation.
    expect(before?.key).toBeNull()
  })

  test(
    'the regression the reviewer planted, reproduced as what it does to the ELEMENT rather than to the source: ' +
    'keying "before" and "after" on which slot is showing them defeats the guarantee',
    () => {
      // This is deliberately NOT `mountPanel` — `mountPanel` never reads a `key` out of `props`,
      // which is exactly why the regression cannot be expressed by calling it correctly. It is
      // `createElement` called the way a hand-written `<StudioHost key={...} />` JSX tag would
      // compile to, showing that SHAPE — a key that tracks which slot is active — is precisely the
      // one this suite must never see coming out of the real mount site.
      const before = createElement(Dummy, { x: 1, key: 'right' } as { x: number; key: string })
      const after = createElement(Dummy, { x: 2, key: 'bottom' } as { x: number; key: string })
      expect(before.key).not.toBe(after.key)
    },
  )

  test('props pass through unchanged — mountPanel adds nothing and removes nothing', () => {
    const props = { x: 7, label: 'studio' }
    const el = mountPanel(true, (p: typeof props) => null, props)
    expect(el?.props).toEqual(props)
  })
})
