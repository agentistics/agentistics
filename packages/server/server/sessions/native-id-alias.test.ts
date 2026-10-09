import { describe, expect, it } from 'bun:test'
import type { SessionMeta } from '@agentistics/core'
import { withNativeAliases } from './native-id-alias'

const UUID = '04d97770-e53f-4b7d-86d2-63bd12ec32eb'
const meta = (id: string, native?: string): SessionMeta =>
  ({ session_id: id, project_path: '/p', start_time: '', harness: 'gemini', ...(native ? { native_session_id: native } : {}) }) as SessionMeta

describe('withNativeAliases', () => {
  const store = new Map([
    ['work/session-a', meta('work/session-a', UUID)],
    ['work/session-b', meta('work/session-b')],
  ])
  const aliased = withNativeAliases(store)

  it('answers to the harness id as well as the store key', () => {
    expect(aliased.get(UUID)?.session_id).toBe('work/session-a')
    expect(aliased.get('work/session-a')?.session_id).toBe('work/session-a')
    expect(aliased.has(UUID)).toBe(true)
    expect(aliased.get('nope')).toBeUndefined()
    expect(aliased.has('nope')).toBe(false)
  })

  it('iterates each session ONCE — the alias is a lookup, not a second key', () => {
    expect([...aliased.keys()]).toEqual(['work/session-a', 'work/session-b'])
    expect(aliased.size).toBe(2)
    expect([...aliased.values()].length).toBe(2)
  })

  it('never lets an alias shadow a real store key', () => {
    const m = withNativeAliases(new Map([
      ['k1', meta('k1', 'k2')],
      ['k2', meta('k2')],
    ]))
    expect(m.get('k2')?.session_id).toBe('k2')
  })
})
