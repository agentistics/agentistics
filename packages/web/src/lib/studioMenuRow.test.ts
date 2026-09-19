import { expect, test } from 'bun:test'
import { studioMenuRow } from './studioMenuRow'

/**
 * The mobile session menu's Studio row mirrors `useStudioShown()` — this is what makes a reader who
 * opened the Studio from THIS row, then came back to the menu, find it marked current. A defect that
 * hardcodes `on: false` regardless of the flag left the whole web suite green (see the fix-wave
 * review's I1); this is the test that would have caught it.
 */
test('the row is on exactly when the caller says the Studio is shown', () => {
  expect(studioMenuRow(true, null, () => {}).on).toBe(true)
  expect(studioMenuRow(false, null, () => {}).on).toBe(false)
})

test('the icon and the select handler pass through untouched', () => {
  const icon = 'an-icon' as unknown as null
  let selected = false
  const row = studioMenuRow(true, icon, () => { selected = true })
  expect(row.icon).toBe(icon)
  expect(row.label).toBe('Studio')
  row.onSelect()
  expect(selected).toBe(true)
})
