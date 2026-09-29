import { describe, expect, test } from 'bun:test'
import { isNayCwd, planNayFiling, NAY_GROUP_NAME } from './nay'

describe('isNayCwd', () => {
  test('Nay\'s own directory, with or without a trailing slash or Windows separators', () => {
    expect(isNayCwd('/home/u/.agentistics/nay-chat')).toBe(true)
    expect(isNayCwd('/home/u/.agentistics/nay-chat/')).toBe(true)
    expect(isNayCwd('C:\\Users\\u\\.agentistics\\nay-chat')).toBe(true)
  })
  test('anything else is not Nay, including a folder that merely contains the name', () => {
    expect(isNayCwd('/home/u/projects/nay-chat')).toBe(false)
    expect(isNayCwd('/home/u/.agentistics/nay-chat/sub')).toBe(false)
    expect(isNayCwd('')).toBe(false)
    expect(isNayCwd(undefined)).toBe(false)
  })
})

describe('planNayFiling', () => {
  test('creates the Nay group the first time, holding the session', () => {
    const plan = planNayFiling({ groups: [] }, [], 'conv-1')
    expect(plan.ok).toBe(true)
    if (!plan.ok) return
    expect(plan.groups.groups).toHaveLength(1)
    expect(plan.groups.groups[0]!.name).toBe(NAY_GROUP_NAME)
    expect(plan.groups.groups[0]!.sessionKeys).toEqual(['conv-1'])
  })
  test('adds to the existing group afterwards, never a second one', () => {
    const first = planNayFiling({ groups: [] }, [], 'conv-1')
    if (!first.ok) throw new Error('first')
    const second = planNayFiling(first.groups, first.pins, 'conv-2')
    if (!second.ok) throw new Error('second')
    expect(second.groups.groups).toHaveLength(1)
    expect(second.groups.groups[0]!.sessionKeys).toEqual(['conv-1', 'conv-2'])
  })
})
