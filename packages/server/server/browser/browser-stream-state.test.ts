/** S10 r3 F2b — the stream's `state` event never carries a query string in the action label, for anyone. */
import { describe, expect, test } from 'bun:test'
import { buildCastState } from './browser-stream-web'

const facts = (label: string) => ({
  activeTab: 'T1',
  tabs: [{ targetId: 'T1', url: 'https://shop.example/cart?token=abc', title: 'Cart', active: true, loading: false }],
  lastAction: { kind: 'navigate', label, at: 5 },
})

describe('buildCastState', () => {
  test('the action label loses its query and fragment', () => {
    const s = buildCastState(facts('https://shop.example/cart?token=abc#access_token=zzz'), 'T1', 'none')!
    expect(s.lastAction?.label).toBe('https://shop.example/cart')
  })
  test('a click label and the coordinates are kept as they were', () => {
    const f = facts('x'); f.lastAction = { kind: 'click', label: 'Buy now', x: 3, y: 4, at: 9 } as typeof f.lastAction
    expect(buildCastState(f, 'T1', 'none')!.lastAction).toEqual({ kind: 'click', label: 'Buy now', x: 3, y: 4, at: 9 })
  })
  test('the tab list, the lock and the active tab come through; a tab that is gone is null', () => {
    const s = buildCastState(facts('a'), 'T1', 'locked')!
    expect(s).toMatchObject({ tab: 'T1', activeTab: 'T1', lock: 'locked', title: 'Cart', loading: false, tabs: [{ id: 'T1', title: 'Cart', active: true }] })
    expect(buildCastState(facts('a'), 'T9', 'none')).toBeNull()
  })
})
