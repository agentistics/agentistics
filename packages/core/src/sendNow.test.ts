import { describe, expect, test } from 'bun:test'
import {
  SEND_NOW_FIRM_MS, SEND_NOW_GENTLE_MS, hasQueuedMessages, sendNowDelivered, sendNowProgress,
} from './sendNow'

const RULE = '─'.repeat(40)

// Frames captured off a live claude 2.1.285 probe (2026-09-29), trimmed to what matters.
const QUEUED_STREAMING = [
  '  He prepared his evening meal and sat in his leather chair to eat.',
  '❯ QUEUED-TWO: stop and reply only with the word mango',
  '  ctrl+x ctrl+s to send now',
  RULE,
  '❯ Press up to edit queued messages',
  RULE,
  '  ⏵⏵ bypass permissions on · 1 shell · esc to interrupt · ← 6 agents · ↓ to manage',
]
const QUEUED_ABOVE_SPINNER = [
  '● Running for i in $(seq 40); do sleep 1; done … · 6s',
  '❯ QUEUED-FIVE: reply only with plum',
  '  ctrl+x ctrl+s to send now',
  '✢ Honking… (10s · ↓ 300 tokens)',
  RULE,
  '❯ ',
  RULE,
  '  ⏵⏵ bypass permissions on · esc to interrupt',
]
const DRAINED = [
  '❯ QUEUED-TWO: stop and reply only with the word mango',
  '● mango',
  '✻ Crunched for 2s · done 9:41 PM',
  RULE,
  '❯ ',
  RULE,
  '  ⏵⏵ bypass permissions on · ← 6 agents',
]

describe('hasQueuedMessages', () => {
  test('sees the queue while a reply streams', () => {
    expect(hasQueuedMessages(QUEUED_STREAMING)).toBe(true)
  })
  test('sees the hint above the spinner even with text typed in the box', () => {
    expect(hasQueuedMessages(QUEUED_ABOVE_SPINNER)).toBe(true)
  })
  test('a drained queue reads as nothing queued', () => {
    expect(hasQueuedMessages(DRAINED)).toBe(false)
  })
  test('the ctrl+enter spelling counts too', () => {
    expect(hasQueuedMessages(QUEUED_ABOVE_SPINNER.map(l => l.replace('ctrl+x ctrl+s', 'ctrl+enter')))).toBe(true)
  })
  test('a QUOTED hint far up the conversation does not count', () => {
    const quoted = [
      '  const SEND_NOW_HINT = "ctrl+x ctrl+s to send now"',
      '  ctrl+x ctrl+s to send now',
      ...Array.from({ length: 20 }, (_, i) => `  line ${i}`),
      RULE, '❯ ', RULE, '  footer',
    ]
    expect(hasQueuedMessages(quoted)).toBe(false)
  })
  test('the hint inside a longer line does not count', () => {
    expect(hasQueuedMessages(['  press ctrl+x ctrl+s to send now, said the doc', RULE, '❯ ', RULE])).toBe(false)
  })
  test('the placeholder outside the input box does not count', () => {
    expect(hasQueuedMessages(['Press up to edit queued messages', ...Array(14).fill('x'), RULE, '❯ ', RULE])).toBe(false)
  })
  test('no input box on screen reads as nothing queued', () => {
    expect(hasQueuedMessages([])).toBe(false)
    expect(hasQueuedMessages(['❯ QUEUED', '  ctrl+x ctrl+s to send now'])).toBe(false)
  })
})

describe('sendNowDelivered', () => {
  test('delivered outcomes', () => {
    expect(sendNowDelivered('sent')).toBe(true)
    expect(sendNowDelivered('interrupted')).toBe(true)
    expect(sendNowDelivered('nothing')).toBe(true)
  })
  test('failed outcomes', () => {
    expect(sendNowDelivered('stuck')).toBe(false)
    expect(sendNowDelivered('no-focus')).toBe(false)
    expect(sendNowDelivered('failed')).toBe(false)
  })
})

describe('sendNowProgress', () => {
  test('starts in the gentle phase with the promised caption', () => {
    const p = sendNowProgress(0, true)
    expect(p.phase).toBe('gentle')
    expect(p.caption).toBe('Inserindo mensagem imediatamente…')
    expect(p.fraction).toBe(0)
  })
  test('switches to the firm phase exactly when the server does', () => {
    expect(sendNowProgress(SEND_NOW_GENTLE_MS - 1, false).phase).toBe('gentle')
    expect(sendNowProgress(SEND_NOW_GENTLE_MS, false).phase).toBe('firm')
    expect(sendNowProgress(SEND_NOW_GENTLE_MS, true).caption).toContain('interrompendo')
  })
  test('grows monotonically and never fills while the request is open', () => {
    let last = -1
    for (let t = 0; t <= (SEND_NOW_GENTLE_MS + SEND_NOW_FIRM_MS) * 3; t += 250) {
      const f = sendNowProgress(t, false).fraction
      expect(f).toBeGreaterThanOrEqual(last)
      expect(f).toBeLessThan(1)
      last = f
    }
  })
  test('a negative clock reads as the start', () => {
    expect(sendNowProgress(-50, false).fraction).toBe(0)
  })
})
