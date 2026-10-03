import { describe, expect, test } from 'bun:test'
import { nativeAttention, nativeRowsFrom, nativeSessionUrl, nativeVisible } from './native'

describe('H22: native sessions in the editor', () => {
  test('shown only where the native runtime may be (an engine providing it, the experimental flag on)', () => {
    const on = { present: true, nativeExperimental: true, manifest: { provides: { nativeRuntime: true } } }
    expect(nativeVisible(on)).toBe(true)
    expect(nativeVisible({ ...on, nativeExperimental: undefined })).toBe(false)
    expect(nativeVisible({ ...on, present: false })).toBe(false)
    expect(nativeVisible(null)).toBe(false)
  })
  test('rows: a person\'s sessions only, with their activity; waiting ones count as attention', () => {
    const rows = nativeRowsFrom({ sessions: [
      { sessionId: 'ses_a', title: 'Fix it', model: 'claude-sonnet-4-6', status: 'open', activity: 'waiting-approval', updatedAt: 'x' },
      { sessionId: 'ses_b', model: 'm', status: 'ended', updatedAt: 'y' },
      { sessionId: 'ses_child', lineage: { parentSessionId: 'ses_a' }, status: 'open' },
      { sessionId: 'ses_c', title: 'Busy', model: 'm', status: 'open', activity: 'working', updatedAt: 'z' },
    ] })
    expect(rows.map(r => r.id)).toEqual(['ses_a', 'ses_b', 'ses_c'])
    expect(rows[1]!.title).toBe('Agentistics')
    expect(nativeAttention(rows)).toBe(1)
    expect(nativeRowsFrom('garbage')).toEqual([])
    expect(nativeSessionUrl('http://127.0.0.1:47291/', 'ses_a')).toBe('http://127.0.0.1:47291/sessions/ses_a')
  })
})
