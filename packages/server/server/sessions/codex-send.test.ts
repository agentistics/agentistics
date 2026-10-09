import { describe, expect, test } from 'bun:test'
import { classifyCodexSendFailure, codexComposerInput, codexIsBlockingFrame, planCodexSend } from './codex-send'

const idle = ['› Find and fix a bug in @filename', '', 'gpt-5.4-mini low · 100% left · /tmp/scratchpad']
const update = [
  'old transcript: please approve this harmless answer',
  '  Update available', '› 1. Update now (runs `bun install -g @openai/codex`)',
  '  2. Skip', '', '  Press enter to continue',
]
const shortInline = ['› fix it', '', 'gpt-5.4-mini low · 100% left · /tmp/scratchpad']
const pasted = ['› [Pasted Content 420 chars]', '', 'gpt-5.4-mini low · 100% left · /tmp/scratchpad']

describe('Codex send decision', () => {
  test('a failed write names the prompt when the pane is still asking', () => {
    expect(classifyCodexSendFailure(update, true)).toBe('prompt')
    expect(classifyCodexSendFailure(idle, false)).toBe('ended')
  })
  test('a LIVE pane that is not on a dialog is unconfirmed, never ended', () => {
    expect(classifyCodexSendFailure(idle, true)).toBe('unconfirmed')
    expect(classifyCodexSendFailure(update, false)).toBe('ended')
  })
  test('real update prompt is blocked before any paste', () => {
    expect(codexIsBlockingFrame(update)).toBe(true)
    expect(planCodexSend('before-paste', update)).toBe('blocked')
  })

  test('waits for the real pasted-content chip before pressing Enter', () => {
    expect(planCodexSend('after-paste', idle)).toBe('wait')
    expect(planCodexSend('after-paste', pasted, 'a long message')).toBe('enter')
    expect(planCodexSend('after-paste', shortInline, 'fix it')).toBe('enter')
  })

  test('a chip after the first Enter requests exactly one retry', () => {
    expect(planCodexSend('after-enter', pasted, 'a long message')).toBe('retry-enter')
    expect(planCodexSend('after-retry', idle)).toBe('delivered')
  })

  test('a cleared composer is delivered and does not get a redundant retry', () => {
    expect(planCodexSend('after-enter', idle)).toBe('delivered')
  })

  test('a chip still present after the retry is a failed verification', () => {
    expect(planCodexSend('after-retry', pasted, 'a long message')).toBe('failed')
  })

  test('a short inline composer tail is delivered once it disappears', () => {
    expect(planCodexSend('after-enter', shortInline, 'fix it')).toBe('retry-enter')
    expect(planCodexSend('after-enter', idle, 'fix it')).toBe('delivered')
  })

  test('ordinary answer text containing approve is not a blocker', () => {
    const answer = ['previous answer: approve the change', ...idle]
    expect(codexIsBlockingFrame(answer)).toBe(false)
  })

  test('a stale Press enter footer in scrollback is not a blocker', () => {
    const scrollback = [
      'old dialog',
      'Press enter to continue',
      'old output 1',
      'old output 2',
      'old output 3',
      'old output 4',
      'old output 5',
      'old output 6',
      'old output 7',
      ...idle,
    ]
    expect(codexIsBlockingFrame(scrollback)).toBe(false)
  })
})

// A message Codex has just taken is drawn in the history with the SAME `›` marker the composer uses,
// directly above an empty composer. Measured on codex 0.160.1 / 0.161.0.
const SENT = '[from session child-1 · handback]\nfinished the migration, all green'
const echoed = [
  '• Done with the previous task.',
  '',
  '› [from session child-1 · handback]',
  '  finished the migration, all green',
  '',
  '• Working (2s • esc to interrupt)',
  '',
  '› Find and fix a bug in @filename',
  '',
  'gpt-5.4-mini low · 100% left · /tmp/scratchpad',
]
const stillTyped = [
  '• Done with the previous task.',
  '',
  '› [from session child-1 · handback]',
  '  finished the migration, all green',
  '',
  'gpt-5.4-mini low · 100% left · /tmp/scratchpad',
]

describe('Codex composer vs history echo (the false "session ended")', () => {
  test('the composer input is the last marker above the status line', () => {
    expect(codexComposerInput(echoed)).toEqual(['› Find and fix a bug in @filename', ''])
    expect(codexComposerInput(stillTyped)[0]).toBe('› [from session child-1 · handback]')
  })
  test('a delivered message echoed in the history is NOT read as still typed', () => {
    expect(planCodexSend('after-enter', echoed, SENT)).toBe('delivered')
    expect(planCodexSend('after-retry', echoed, SENT)).toBe('delivered')
  })
  test('text really still in the composer after the retry is a failed verification', () => {
    expect(planCodexSend('after-enter', stillTyped, SENT)).toBe('retry-enter')
    expect(planCodexSend('after-retry', stillTyped, SENT)).toBe('failed')
  })
  test('a stale chip echoed in the history does not satisfy the next paste', () => {
    const staleChip = ['› [Pasted Content 900 chars]', '', '• Working (1s)', '', '› Find and fix a bug in @filename', '', 'gpt-5.4-mini low · 100% left · /tmp']
    expect(planCodexSend('after-paste', staleChip, 'the next message')).toBe('wait')
  })
  test('with no marker in reach the legacy 8-line area still applies', () => {
    const noMarker = ['plain', 'finished the migration, all green', 'gpt-5.4-mini low · 100% left · /tmp']
    expect(planCodexSend('after-enter', noMarker, SENT)).toBe('retry-enter')
  })
})
