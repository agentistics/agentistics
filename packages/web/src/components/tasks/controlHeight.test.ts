import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { button } from './board'
import { viewSegment } from './ViewBar'

// One standard: controls are 32px on desktop and 44px on a phone; a tab inside a 32px group is 24px.
describe('control heights', () => {
  test('the plain button', () => {
    expect(button(false).height).toBe(32)
    expect(button(true).height).toBe(44)
  })
  test('a segment inside a 32px bar is 24px on desktop, 44 on a phone', () => {
    expect(viewSegment(false).minHeight).toBe(24)
    expect(viewSegment(true).minHeight).toBe(44)
  })
  test('the shared defaults say 32', () => {
    const src = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8')
    expect(src('../FiltersBar.tsx')).toMatch(/outline: 'none',\n  height: 32,/)
    expect(src('../sessions/formBits.tsx')).toContain('height ?? (tap ? undefined : 32)')
    expect(src('./AgentaskToolbar.tsx')).toContain('mobile ? 44 : 24')
  })
})
