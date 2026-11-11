import { describe, expect, it } from 'bun:test'
import { isLiveState } from './liveState'

describe('isLiveState', () => {
  it('recognizes every live state', () => {
    for (const state of ['working', 'waiting', 'waiting-approval', 'idle']) expect(isLiveState(state)).toBe(true)
  })

  it('rejects terminal and unknown states', () => {
    for (const state of ['exited', 'lost', 'closed', 'unknown', undefined]) expect(isLiveState(state)).toBe(false)
  })
})
