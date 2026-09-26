import { describe, expect, test } from 'bun:test'
import { relayedComposerState } from './relayedComposer'

const verb = (enabled: boolean, reason?: string) => ({ action: 'prompt' as const, label: 'Send', enabled, ...(reason ? { reason } : {}) })

describe('relayedComposerState', () => {
  test('no row, or no prompt verb (screen not granted): no field', () => {
    expect(relayedComposerState(undefined)).toEqual({ kind: 'absent' })
    expect(relayedComposerState({ verbs: [{ action: 'rename', label: 'Rename', enabled: true }] })).toEqual({ kind: 'absent' })
  })
  test("a disabled prompt carries the machine's own sentence", () => {
    expect(relayedComposerState({ verbs: [verb(false, 'Not running')] })).toEqual({ kind: 'refused', reason: 'Not running' })
    expect(relayedComposerState({ verbs: [verb(false)] })).toEqual({ kind: 'refused', reason: null })
  })
  test('an enabled prompt draws the field', () => {
    expect(relayedComposerState({ verbs: [verb(true)] })).toEqual({ kind: 'send' })
  })
})
