import { describe, expect, test } from 'bun:test'
import { railTooltipShown } from './railTooltip'

describe('railTooltipShown', () => {
  test('a hovered icon in the rail shows its tooltip', () => {
    expect(railTooltipShown({ id: 'studio' }, ['studio', 'live'], false)).toBe(true)
  })
  test('nothing while a drag is in flight — the browser fires no mouseleave then', () => {
    expect(railTooltipShown({ id: 'studio' }, ['studio', 'live'], true)).toBe(false)
  })
  test('an icon that left the rail (moved to the bottom bar) takes its tooltip with it', () => {
    // The reported defect: the button unmounted on drop, no leave event arrived, the tooltip stayed.
    expect(railTooltipShown({ id: 'studio' }, ['live'], false)).toBe(false)
  })
  test('nothing named, nothing shown', () => {
    expect(railTooltipShown(null, ['studio'], false)).toBe(false)
  })
})
