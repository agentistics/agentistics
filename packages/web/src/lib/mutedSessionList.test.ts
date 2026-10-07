import { describe, expect, test } from 'bun:test'
import { mutedSessionCount, mutedSessionRows, type MutedSessionRow } from './mutedSessionList'

const rows: MutedSessionRow[] = [
  { id: 'managed-a', conversationId: 'conversation-a', title: 'Alpha', harness: 'claude', state: 'working' },
  { id: 'managed-b', title: 'Beta', harness: 'codex', state: 'waiting' },
  { id: 'managed-c', conversationId: 'conversation-c', title: 'Gamma', harness: 'gemini', state: 'exited' },
]

describe('mutedSessionRows', () => {
  test('matches conversation identity before managed id', () => {
    expect(mutedSessionRows(rows, ['conversation-a', 'managed-b']).map(row => row.title))
      .toEqual(['Alpha', 'Beta'])
  })

  test('does not duplicate a row when keys repeat', () => {
    expect(mutedSessionRows(rows, ['conversation-a', 'conversation-a'])).toHaveLength(1)
  })

  test('deduplicates duplicate fleet rows by session identity', () => {
    expect(mutedSessionRows([...rows, { ...rows[0]!, id: 'reopened-a' }], ['conversation-a'])).toHaveLength(1)
  })

  test('does not count ended muted sessions, but counts them again when reopened', () => {
    const ended = { ...rows[0]!, state: 'exited' as const }
    expect(mutedSessionCount([ended], ['conversation-a'])).toBe(0)
    expect(mutedSessionCount([{ ...ended, state: 'working' }], ['conversation-a'])).toBe(1)
  })

  test('counts only currently known muted rows', () => {
    expect(mutedSessionCount(rows, ['conversation-a', 'missing'])).toBe(1)
  })
})
