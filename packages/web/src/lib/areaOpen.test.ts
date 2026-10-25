import { describe, expect, it } from 'bun:test'
import { isAreaOpen, openedArea, parseAreaOpen, toggledAreaOpen } from './areaOpen'

describe('areaOpen', () => {
  it('follows the active area until the person decides', () => {
    expect(isAreaOpen({}, 'usage', true)).toBe(true)
    expect(isAreaOpen({}, 'metrics', false)).toBe(false)
    expect(isAreaOpen({ usage: false }, 'usage', true)).toBe(false)
  })
  it('toggle stores the explicit opposite', () => {
    expect(toggledAreaOpen({}, 'metrics', false)).toEqual({ metrics: true })
    expect(toggledAreaOpen({}, 'usage', true)).toEqual({ usage: false })
  })
  it('selecting an area opens it, even one closed by hand', () => {
    expect(openedArea({ agentask: false }, 'agentask')).toEqual({ agentask: true })
    expect(openedArea({}, 'usage')).toEqual({ usage: true })
    const open = { usage: true }
    expect(openedArea(open, 'usage')).toBe(open)
  })
  it('parse is total', () => {
    expect(parseAreaOpen('x')).toBeNull()
    expect(parseAreaOpen({ a: true, b: 3 })).toEqual({ a: true })
  })
})

it('opening an area closes the others held open, so the tree never stacks every visited area', () => {
  let map = openedArea({}, 'leadership')
  map = openedArea(map, 'usage')
  map = openedArea(map, 'metrics')
  expect(map).toEqual({ metrics: true })
  for (const id of ['leadership', 'usage']) expect(isAreaOpen(map, id, false)).toBe(false)
  // A hand-closed area stays closed.
  expect(openedArea({ tasks: false, usage: true }, 'metrics')).toEqual({ tasks: false, metrics: true })
})
