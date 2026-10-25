import { describe, expect, test } from 'bun:test'
import { composerAnswerRequest } from './dialogAnswer'

describe('composerAnswerRequest', () => {
  test('a structured multi-select sends the typed answer WITH the other ticks', () => {
    // Live QA: Green (2) ticked, then "Type something" (4) → "Purple". Both must arrive.
    expect(composerAnswerRequest('s1', { number: 4, choices: [2] }, 'Purple'))
      .toEqual({ id: 's1', action: 'approve', choices: [2, 4], text: 'Purple' })
  })
  test('no other ticks still answers as a multi-select with the typed option alone', () => {
    expect(composerAnswerRequest('s1', { number: 4, choices: [] }, 'Purple'))
      .toEqual({ id: 's1', action: 'approve', choices: [4], text: 'Purple' })
  })
  test('every other dialog keeps the single choice + text', () => {
    expect(composerAnswerRequest('s1', { number: 3 }, 'kiwi')).toEqual({ id: 's1', action: 'approve', choice: 3, text: 'kiwi' })
  })
})
