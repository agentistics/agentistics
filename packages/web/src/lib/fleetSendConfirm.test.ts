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
