import { describe, expect, test } from 'bun:test'
import {
  TERMINAL_TARGETS, readTarget, targetLabel, targetScope, targetStreamId,
} from './terminalTarget'

describe('the two things a terminal band can show', () => {
  test('there are exactly two, and shell is not one of the assistants', () => {
    expect(TERMINAL_TARGETS).toEqual(['cli', 'shell'])
  })

  // The two channels are resolved against DIFFERENT stores — the fleet's registry and
  // `shells.json` — so handing one the other's id is the mistake the whole scope split exists to
  // make impossible. The target decides both halves together, in one place.
  test('each target names its own channel AND its own id', () => {
    expect(targetScope('cli')).toBe('fleet')
    expect(targetScope('shell')).toBe('shell')
    expect(targetStreamId('cli', { sessionId: 's1', shellId: 'sh1' })).toBe('s1')
    expect(targetStreamId('shell', { sessionId: 's1', shellId: 'sh1' })).toBe('sh1')
  })

  test('a shell that has not been opened yet has no id to stream', () => {
    expect(targetStreamId('shell', { sessionId: 's1', shellId: null })).toBeNull()
  })

  test('the CLI pane is always streamable — it IS the session', () => {
    expect(targetStreamId('cli', { sessionId: 's1', shellId: null })).toBe('s1')
  })
})

describe('what each target is CALLED', () => {
  // "Assistente" named a concept; the harness names the thing that is actually on the screen, and
  // needs no explanation. Reported as "invés de assistant coloca algo que dê a entender mais fácil".
  test('the CLI pane is named after the harness running in it', () => {
    expect(targetLabel('cli', 'claude', 'pt')).toBe('Claude Code')
    expect(targetLabel('cli', 'codex', 'en')).toBe('Codex CLI')
  })

  test('a harness nobody can name falls back to words, never to a blank segment', () => {
    expect(targetLabel('cli', undefined, 'pt')).toBe('Sessão CLI')
    expect(targetLabel('cli', undefined, 'en')).toBe('CLI session')
    expect(targetLabel('cli', 'nope' as never, 'pt')).toBe('Sessão CLI')
  })

  test('the shell is called Shell in both languages — it is the word the product already uses', () => {
    expect(targetLabel('shell', 'claude', 'pt')).toBe('Shell')
    expect(targetLabel('shell', 'claude', 'en')).toBe('Shell')
  })
})

describe('the stored target', () => {
  test('absent or unreadable reads as the SHELL, which is what the band has always been', () => {
    for (const raw of [undefined, null, '', 'nope', 7]) {
      expect(readTarget(raw), String(raw)).toBe('shell')
    }
  })

  test('a stored target is honoured', () => {
    expect(readTarget('cli')).toBe('cli')
    expect(readTarget('shell')).toBe('shell')
  })
})
