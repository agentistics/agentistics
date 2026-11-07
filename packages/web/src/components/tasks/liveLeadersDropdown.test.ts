import { describe, expect, test } from 'bun:test'
import { dropdownShift, dropdownWidth, leaderRuntime } from './LiveLeaders'

describe('the Líderes dropdown stays on screen (QA LOW 10)', () => {
  test('at 390 px the button sits at x=28: the box is shifted left so its right edge ends inside the screen', () => {
    const width = dropdownWidth(390)
    expect(width).toBe(366)
    const shift = dropdownShift({ viewport: 390, left: 28, width })
    expect(28 + shift).toBeGreaterThanOrEqual(0)
    expect(28 + shift + width).toBeLessThanOrEqual(390 - 12)
  })
  test('on a wide screen it does not move, and it is never pushed off the left edge', () => {
    expect(dropdownShift({ viewport: 1280, left: 400, width: 400 })).toBe(0)
    expect(dropdownShift({ viewport: 300, left: 5, width: 400 }) + 5).toBeGreaterThanOrEqual(0)
  })
})

describe('the leader line names the model the way the composer does (QA MED 9)', () => {
  const l = (over: object) => ({ id: 'L', title: 'Motor', harness: 'claude', model: null, state: 'working', currentAction: null, workers: [], awaiting: [], ...over }) as never
  test('the transcript\'s model is shown as a person reads it, not the raw id', () => {
    expect(leaderRuntime(l({ model: 'claude-opus-5-5', effort: 'high' }), undefined, true)).toBe('claude · Opus 5.5 · high')
  })
  test('with no model known it says default, and marks the harness default it falls back to', () => {
    expect(leaderRuntime(l({}), { claude: { model: 'opus', effortConcept: true } }, true)).toContain('Opus 5 (padrão)')
    expect(leaderRuntime(l({}), undefined, true)).toBe('claude · modelo padrão')
  })
})
