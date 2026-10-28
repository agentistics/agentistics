import { describe, expect, test } from 'bun:test'
import { resolveSessionAccount, sessionAccountRow, type AccountRegistryView, type SessionAccountRow } from './session-account'

// CONTA.IDENTIDADE: a session started on account A, then restarted (or switched) onto account B,
// leaves an ENDED row on A and a LIVE row on B for the same conversation. Every surface must say B.
const conv = '11230b34-0c8b-46d0-b2c5-a0c7f44fd5b7'
const rowA: SessionAccountRow = { id: 'rowA', harness: 'claude', conversationId: conv, accountId: 'acc_A', createdAt: '2026-10-27T17:42:09.950Z', endedAt: '2026-10-28T04:33:17.749Z' }
const rowB: SessionAccountRow = { id: 'rowB', harness: 'claude', conversationId: conv, accountId: 'acc_B', createdAt: '2026-10-28T04:33:15.025Z' }

const registry: AccountRegistryView = {
  accounts: [
    { id: 'acc_A', harness: 'claude', key: 'a', label: 'A', plan: 'max', available: true, firstSeen: 0, lastSeen: 0 },
    { id: 'acc_B', harness: 'claude', key: 'b', label: 'B', plan: 'max', available: true, firstSeen: 0, lastSeen: 0 },
    { id: 'acc_P', harness: 'claude', key: 'p', label: 'P', plan: 'pro', available: false, firstSeen: 0, lastSeen: 0 },
  ] as AccountRegistryView['accounts'],
  bindings: { 'claude:': 'acc_A' },
}

describe('sessionAccountRow', () => {
  test('an exact row id wins over the conversation', () => {
    expect(sessionAccountRow([rowA, rowB], { id: 'rowA', conversationId: conv })?.id).toBe('rowA')
  })

  test('by conversation: the LIVE row wins over an ended one, whatever the file order', () => {
    expect(sessionAccountRow([rowA, rowB], { conversationId: conv })?.id).toBe('rowB')
    expect(sessionAccountRow([rowB, rowA], { conversationId: conv })?.id).toBe('rowB')
  })

  test('by conversation, all ended: the newest row wins', () => {
    const endedB = { ...rowB, endedAt: '2026-10-28T05:00:00.000Z' }
    expect(sessionAccountRow([endedB, rowA], { conversationId: conv })?.id).toBe('rowB')
  })

  test('a reference naming nothing answers nothing', () => {
    expect(sessionAccountRow([rowA, rowB], { id: 'nope' })).toBeUndefined()
    expect(sessionAccountRow([rowA, rowB], {})).toBeUndefined()
  })
})

describe('resolveSessionAccount', () => {
  test('started on A, restarted onto B: the answer is B by row id, by conversation and in any order', () => {
    expect(resolveSessionAccount([rowA, rowB], { id: 'rowB' }, registry)).toBe('acc_B')
    expect(resolveSessionAccount([rowA, rowB], { conversationId: conv }, registry)).toBe('acc_B')
    expect(resolveSessionAccount([rowB, rowA], { id: conv, conversationId: conv }, registry)).toBe('acc_B')
  })

  test('aliases are followed to the surviving id', () => {
    expect(resolveSessionAccount([rowB], { id: 'rowB' }, { ...registry, aliases: { acc_B: 'acc_B2' } })).toBe('acc_B2')
  })

  test('a row with no account runs in the default home: the account bound to it', () => {
    const plain = { id: 'plain', harness: 'claude' }
    expect(resolveSessionAccount([plain], { id: 'plain' }, registry)).toBe('acc_A')
    // Without the registry nothing is guessed.
    expect(resolveSessionAccount([plain], { id: 'plain' })).toBeUndefined()
  })

  test('no default binding and two visible accounts: no guess', () => {
    const plain = { id: 'plain', harness: 'claude' }
    expect(resolveSessionAccount([plain], { id: 'plain' }, { ...registry, bindings: {} })).toBeUndefined()
  })

  test('no managed row: undefined (an external process is attributed by path elsewhere)', () => {
    expect(resolveSessionAccount([], { id: 'x', conversationId: 'x' }, registry)).toBeUndefined()
  })
})
