import { describe, expect, test } from 'bun:test'
import { confirmSendLanded, textInUserTurns } from './fleetAct'

const nosleep = async () => {}

describe('textInUserTurns', () => {
  test('finds the message among user turns, ignoring whitespace', () => {
    expect(textInUserTurns([{ role: 'user', text: 'fix  the\nbug' }], 'fix the bug')).toBe(true)
  })
  test('an assistant echo or an absent message does not count', () => {
    expect(textInUserTurns([{ role: 'assistant', text: 'fix the bug' }], 'fix the bug')).toBe(false)
    expect(textInUserTurns([], 'x')).toBe(false)
    expect(textInUserTurns([{ role: 'user', text: 'x' }], '  ')).toBe(false)
  })
})

describe('confirmSendLanded', () => {
  test('true as soon as the message shows, without further checks', async () => {
    let n = 0
    expect(await confirmSendLanded(async () => ++n === 2, { sleep: nosleep })).toBe(true)
    expect(n).toBe(2)
  })
  test('false after every attempt when it never shows', async () => {
    let n = 0
    expect(await confirmSendLanded(async () => { n++; return false }, { attempts: 3, sleep: nosleep })).toBe(false)
    expect(n).toBe(3)
  })
  test('a throwing check is "not yet", not an answer', async () => {
    let n = 0
    expect(await confirmSendLanded(async () => { if (++n < 2) throw new Error('net'); return true }, { sleep: nosleep })).toBe(true)
  })
})

import { chatHoldsText, textInPending } from './fleetAct'
describe('textInPending', () => {
  test('finds a mid-turn delivery held by the server, whitespace-normalised', () => {
    expect(textInPending([{ text: 'fix  the\nbug' }], 'fix the bug')).toBe(true)
  })
  test('absent text, empty text or no pending is not landed', () => {
    expect(textInPending([{ text: 'other' }], 'fix the bug')).toBe(false)
    expect(textInPending(undefined, 'x')).toBe(false)
    expect(textInPending([{ text: 'x' }], ' ')).toBe(false)
  })
  test('landed check accepts pending and refuses when nothing carries the text', async () => {
    const mk = (b: { turns: { role: string; text: string }[]; pending: { text: string }[] }) => async () =>
      chatHoldsText(b, 'hi')
    expect(await confirmSendLanded(mk({ turns: [], pending: [{ text: 'hi' }] }), { attempts: 2, sleep: async () => {} })).toBe(true)
    expect(await confirmSendLanded(mk({ turns: [], pending: [] }), { attempts: 2, sleep: async () => {} })).toBe(false)
  })
})

describe('chatHoldsText', () => {
  test('a turn or a pending entry counts; a different text does not', () => {
    expect(chatHoldsText({ turns: [{ role: 'user', text: 'say hi there' }] }, 'hi there')).toBe(true)
    expect(chatHoldsText({ turns: [{ role: 'assistant', text: 'hi there' }], pending: [{ text: 'hi there' }] }, 'hi there')).toBe(true)
    expect(chatHoldsText({ turns: [{ role: 'assistant', text: 'hi there' }], pending: [] }, 'hi there')).toBe(false)
  })
})
