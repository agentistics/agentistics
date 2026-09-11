import { describe, expect, test } from 'bun:test'
import type { SessionState } from '@agentistics/tui/control/session-fleet'
import { STATE_COLOR, sessionCardStyle } from './sessionCardStyle'

const STATES: SessionState[] =
  ['working', 'waiting', 'waiting-approval', 'exited', 'lost', 'closed', 'unknown']

describe('sessionCardStyle — selected always wins', () => {
  test('every state, every mode, selected renders the same neutral style', () => {
    for (const state of STATES) {
      for (const mode of ['wash', 'neutral', 'stripe'] as const) {
        const out = sessionCardStyle(state, mode, true)
        expect(out.background).toBe('var(--bg-elevated)')
        expect(out.edge).toContain('var(--text-primary)')
        expect(out.stateTextColor).toBeUndefined()
      }
    }
  })
})

describe('sessionCardStyle — wash', () => {
  test('every one of the seven states gets its own tint and edge', () => {
    for (const state of STATES) {
      const out = sessionCardStyle(state, 'wash', false)
      expect(out.background).toContain(STATE_COLOR[state])
      expect(out.edge).toBe(`inset 2px 0 0 ${STATE_COLOR[state]}`)
      expect(out.stateTextColor).toBeUndefined()
    }
  })

  test('the two states that need a person keep their existing 12% figure', () => {
    expect(sessionCardStyle('waiting', 'wash', false).background).toContain('12%')
    expect(sessionCardStyle('waiting-approval', 'wash', false).background).toContain('12%')
    expect(sessionCardStyle('working', 'wash', false).background).toContain('10%')
  })
})

describe('sessionCardStyle — neutral', () => {
  test('no background tint and no edge — the state word carries the color instead', () => {
    for (const state of STATES) {
      const out = sessionCardStyle(state, 'neutral', false)
      expect(out.background).toBe('transparent')
      expect(out.edge).toBeUndefined()
      expect(out.stateTextColor).toBe(STATE_COLOR[state])
    }
  })
})

describe('sessionCardStyle — stripe', () => {
  test('no background tint, a colored left edge, no text override', () => {
    for (const state of STATES) {
      const out = sessionCardStyle(state, 'stripe', false)
      expect(out.background).toBe('transparent')
      expect(out.edge).toBe(`inset 3px 0 0 ${STATE_COLOR[state]}`)
      expect(out.stateTextColor).toBeUndefined()
    }
  })
})

describe('STATE_COLOR', () => {
  test('lost is its own color, no longer sharing the tertiary fallback with exited/closed', () => {
    expect(STATE_COLOR.lost).toBe('var(--accent-red)')
    expect(STATE_COLOR.lost).not.toBe(STATE_COLOR.exited)
  })
})
