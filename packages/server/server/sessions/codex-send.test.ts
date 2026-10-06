import { describe, expect, test } from 'bun:test'
import { codexIsBlockingFrame, planCodexSend } from './codex-send'

const idle = ['› Find and fix a bug in @filename', '', 'gpt-5.4-mini low · 100% left · /tmp/scratchpad']
const update = [
  'old transcript: please approve this harmless answer',
  '  Update available', '› 1. Update now (runs `bun install -g @openai/codex`)',
  '  2. Skip', '', '  Press enter to continue',
]
const shortInline = ['› fix it', '', 'gpt-5.4-mini low · 100% left · /tmp/scratchpad']
const pasted = ['› [Pasted Content 420 chars]', '', 'gpt-5.4-mini low · 100% left · /tmp/scratchpad']

describe('Codex send decision', () => {
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
