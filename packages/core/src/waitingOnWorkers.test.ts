import { describe, expect, it } from 'bun:test'
import { busyChildCounts, needsOwner, ownerState, type TeamStateRow } from './waitingOnWorkers'

const row = (id: string, over: Partial<TeamStateRow> = {}): TeamStateRow => ({ id, busy: false, ...over })

describe('busyChildCounts', () => {
  it('counts the busy children that name the leader, by managed id or conversation id', () => {
    const counts = busyChildCounts([
      row('lead', { conversationId: 'c-lead' }),
      row('w1', { parentSessionId: 'lead', busy: true }),
      row('w2', { parentConversationId: 'c-lead', busy: true }),
      row('w3', { parentSessionId: 'lead', parentConversationId: 'c-lead', busy: true }),
      row('quiet', { parentSessionId: 'lead' }),
      row('other', { parentSessionId: 'someone-else', busy: true }),
    ])
    expect(counts.get('lead')).toBe(3)
  })

  it('has no entry without a busy child, and a row is never its own child', () => {
    const counts = busyChildCounts([
      row('lead', { conversationId: 'c', parentConversationId: 'c', busy: true }),
      row('w', { parentSessionId: 'lead' }),
    ])
    expect(counts.size).toBe(0)
  })
})

describe('busyChildCounts is transitive', () => {
  it('a sub-leader waiting on its own busy worker is busy for the leader above it, three levels down', () => {
    const counts = busyChildCounts([
      row('top', { canWait: true }),
      row('mid', { parentSessionId: 'top', canWait: true }),
      row('sub', { parentSessionId: 'mid', canWait: true }),
      row('leaf', { parentSessionId: 'sub', busy: true }),
      row('idle-child', { parentSessionId: 'top', canWait: true }),
    ])
    // The figure stays the number of DIRECT children busy (directly or transitively).
    expect(counts.get('sub')).toBe(1)
    expect(counts.get('mid')).toBe(1)
    expect(counts.get('top')).toBe(1)
    expect(counts.has('idle-child')).toBe(false)
  })

  it('a child that cannot wait (exited, in a dialog) does not pass its workers up', () => {
    const counts = busyChildCounts([
      row('top', { canWait: true }),
      row('mid', { parentSessionId: 'top' }),
      row('leaf', { parentSessionId: 'mid', busy: true }),
    ])
    expect(counts.get('mid')).toBe(1)
    expect(counts.has('top')).toBe(false)
  })

  it('a cycle of idle rows never makes anyone busy, and a busy row in a cycle stops', () => {
    expect(busyChildCounts([
      row('a', { parentSessionId: 'c', canWait: true }),
      row('b', { parentSessionId: 'a', canWait: true }),
      row('c', { parentSessionId: 'b', canWait: true }),
    ]).size).toBe(0)
    const counts = busyChildCounts([
      row('a', { parentSessionId: 'b', canWait: true }),
      row('b', { parentSessionId: 'a', canWait: true }),
      row('w', { parentSessionId: 'a', busy: true }),
    ])
    expect(counts.get('a')).toBe(2)
    expect(counts.get('b')).toBe(1)
  })
})

describe('needsOwner / ownerState', () => {
  it('a turn that ended with busy workers is not the owner\'s', () => {
    expect(needsOwner({ state: 'waiting', waitingOnWorkers: 2 })).toBe(false)
    expect(ownerState({ state: 'waiting', waitingOnWorkers: 2 })).toBe('idle')
  })

  it('without them it is, and a dialog wins over the workers', () => {
    expect(needsOwner({ state: 'waiting' })).toBe(true)
    expect(needsOwner({ state: 'waiting', waitingOnWorkers: 0 })).toBe(true)
    expect(needsOwner({ state: 'waiting-approval', waitingOnWorkers: 2 })).toBe(true)
    expect(ownerState({ state: 'waiting-approval', waitingOnWorkers: 2 })).toBe('waiting-approval')
    expect(needsOwner({ state: 'working' })).toBe(false)
  })
})
