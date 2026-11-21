import { describe, expect, test } from 'bun:test'
import { checkRef, type TabRefState } from './browser-action-spec'
import { parseBoundRef, refOf } from './ax-snapshot'

const live: TabRefState = { gen: 4, loaderId: 'L1' }

describe('a ref is bound to the snapshot and the document it came from', () => {
  test('refOf / parseBoundRef round-trip; a bare ref has no generation; junk is refused', () => {
    expect(refOf(12, 3)).toBe('e12@g3')
    expect(refOf(12)).toBe('e12')
    expect(parseBoundRef('e12@g3')).toEqual({ id: 12, gen: 3 })
    expect(parseBoundRef('e12')).toEqual({ id: 12, gen: null })
    for (const bad of ['e12@g0', 'e12@g', 'e12@3', 'e0@g1', 'e12@g1x', '@g1', 'e12@g1@g1', '', 5, null]) expect(parseBoundRef(bad as any)).toBeNull()
  })

  const table: [string, string, TabRefState | undefined, string | null, boolean][] = [
    ['same snapshot, same document', 'e12@g4', live, 'L1', true],
    ['an older snapshot of the same page', 'e12@g3', live, 'L1', false],
    ['a newer generation than the page has (invented)', 'e12@g5', live, 'L1', false],
    ['navigation: another document, same generation', 'e12@g4', live, 'L2', false],
    ['the document could not be read', 'e12@g4', live, null, false],
    ['a bare ref carries no binding', 'e12', live, 'L1', false],
    ['no snapshot taken on this tab yet', 'e12@g1', undefined, 'L1', false],
    ['refs were invalidated (navigation, tab switch)', 'e12@g4', { gen: null, loaderId: 'L1' }, 'L1', false],
    ['not a ref at all', 'button', live, 'L1', false],
  ]
  for (const [name, ref, state, loader, ok] of table) {
    test(name, () => {
      const r = checkRef(ref, state, loader)
      expect(r.ok).toBe(ok)
      if (r.ok) expect(r.id).toBe(12)
      else {
        expect(r.error).toBe('stale_ref')
        expect(r.sentence).toMatch(/snapshot/i)
      }
    })
  }
})
