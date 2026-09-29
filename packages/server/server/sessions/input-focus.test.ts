import { describe, expect, test } from 'bun:test'
import { inputFocusOf } from './input-focus'

// Frames captured from a live claude 2.1.284 (2026-09-29) with a background agent running.
const RULE = '─'.repeat(120)
const inputFocused = [
  '✻ Sautéed for 15s · done 2:12 PM · 1 shell still running',
  RULE,
  '❯ PROBE-MSG-THREE responda apenas: recebido três',
  RULE,
  '  ⏵⏵ auto mode on · 1 shell · ← 6 agents · ↓ to manage',
  '  ● main',
  '  ◯ general-purpose  Run background sleep 120                  4s · ↓ 36.4k tokens',
]
const listFocused = [
  RULE,
  '❯ ',
  RULE,
  '  ⏵⏵ auto mode on · 1 shell · esc to interrupt · Enter to view tasks',
  '  ● main',
  '  ◯ general-purpose  Run background sleep 120                  4s · ↓ 36.4k tokens',
]
const detailOpen = [
  '  Shell details',
  '  Status:   running',
  '  Command:  sleep 120',
  '  Output:',
  '  No output available',
  '  ← to go back · Esc/Enter/Space to close · x to stop',
]

describe('inputFocusOf — where a keystroke will land', () => {
  test('the input box, with the agents list drawn under the footer', () => {
    expect(inputFocusOf(inputFocused)).toBe('input')
  })
  test('the agents list — where the Enter opened a detail view instead of sending', () => {
    expect(inputFocusOf(listFocused)).toBe('tasks')
  })
  test('an agent detail view open over the conversation', () => {
    expect(inputFocusOf(detailOpen)).toBe('overlay')
  })
  test('a titled rule (the history browser) is still a rule', () => {
    expect(inputFocusOf(['─── History 4/4 ' + '─'.repeat(40), '❯ old prompt', RULE, '  ⏵⏵ auto mode on · 1 shell'])).toBe('input')
  })
  test('the marker QUOTED in the conversation is not the footer', () => {
    // This file's own strings on screen, above the input box, in a session editing it.
    const quoting = ['  const TASKS_FOCUSED = /Enter to view tasks/', 'and Esc/Enter/Space to close too', RULE, '❯ ', RULE, '  ? for shortcuts']
    expect(inputFocusOf(quoting)).toBe('input')
  })
  test('a harness with none of these markers is always input', () => {
    expect(inputFocusOf(['codex> ', '  Enter to send'])).toBe('input')
  })
})
