import { describe, expect, test } from 'bun:test'
import { dialogAnswersToRetire } from './dialogAnswerEcho'

describe('dialogAnswersToRetire', () => {
  test('an answer whose dialog is STILL open is kept', () => {
    const pending = new Map([['capivara', 'question-A']])
    expect(dialogAnswersToRetire(pending, 'question-A')).toEqual([])
  })

  test('an answer whose dialog CLOSED entirely is retired', () => {
    const pending = new Map([['capivara', 'question-A']])
    expect(dialogAnswersToRetire(pending, null)).toEqual(['capivara'])
  })

  test('an answer whose dialog moved ON to a different question is retired', () => {
    const pending = new Map([['capivara', 'question-A']])
    expect(dialogAnswersToRetire(pending, 'question-B')).toEqual(['capivara'])
  })

  test('several pending answers are judged independently', () => {
    const pending = new Map([
      ['still waiting', 'question-A'],
      ['already moved on', 'question-B'],
    ])
    expect(dialogAnswersToRetire(pending, 'question-A')).toEqual(['already moved on'])
  })

  test('nothing pending retires nothing', () => {
    expect(dialogAnswersToRetire(new Map(), 'question-A')).toEqual([])
  })
})
