import { describe, expect, test } from 'bun:test'
import { duplicateNote, mcpAuthDone, mcpStateNote, mcpStateText, planReopen, type SessionLike } from './mcpAuth'

describe('mcpStateText', () => {
  test('signed in is never called connected; not connected never claims a cause', () => {
    expect(mcpStateText('authenticated', false).text).toBe('Signed in')
    expect(mcpStateText('disconnected', false).text).toBe('Not connected')
    expect(mcpStateText('needs-auth', true)).toEqual({ text: 'Precisa autenticar', tone: 'warn' })
    expect(mcpStateText('connected', false).tone).toBe('good')
  })
})

describe('mcpStateNote', () => {
  test('the states that would mislead carry their caveat; plain ones do not', () => {
    expect(mcpStateNote({ state: 'authenticated', name: 'x' }, 'Codex', false)).toContain('does not say whether it is answering')
    expect(mcpStateNote({ state: 'disconnected', name: 'x' }, 'Gemini CLI', true)).toContain('não diz por que')
    expect(mcpStateNote({ state: 'error', detail: 'ENOENT', name: 'x' }, 'Claude Code', false)).toBe('ENOENT')
    expect(mcpStateNote({ state: 'connected', name: 'x' }, 'Claude Code', false)).toBeNull()
  })
  test('the duplicate sentence says nothing is touched', () => {
    expect(duplicateNote({ name: 'plugin:figma:figma', duplicateOf: 'figma' }, false)).toContain('nothing is created or removed')
    expect(duplicateNote({ name: 'figma' }, false)).toBeNull()
  })
})

describe('planReopen', () => {
  const s = (id: string, harness: string, state: string, conversationId?: string): SessionLike =>
    ({ id, title: id, harness, state, ...(conversationId ? { conversationId } : {}) })
  test('only sessions of the harness, idle ones reopenable, busy ones said and left alone', () => {
    const plan = planReopen([
      s('a', 'claude', 'waiting', 'c1'),
      s('b', 'claude', 'working', 'c2'),
      s('c', 'claude', 'waiting-approval', 'c3'),
      s('d', 'codex', 'waiting', 'c4'),
      s('e', 'claude', 'exited', 'c5'),
      s('f', 'claude', 'waiting'), // no conversation to resume
    ], 'claude')
    expect(plan.reopenable.map(r => r.id)).toEqual(['a'])
    expect(plan.busy.map(r => r.id)).toEqual(['b', 'c', 'f'])
  })
})

describe('mcpAuthDone', () => {
  test('terminal phases', () => {
    expect(mcpAuthDone({ phase: 'awaiting' })).toBe(false)
    expect(mcpAuthDone({ phase: 'connected' })).toBe(true)
    expect(mcpAuthDone({ phase: 'failed' })).toBe(true)
  })
})
