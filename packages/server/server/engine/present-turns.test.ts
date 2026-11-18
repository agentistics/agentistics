import { describe, expect, test } from 'bun:test'
import type { ChatTurn } from '@agentistics/core'
import type { EnginePresentation } from '@agentistics/engine-api'
import { presentChatTurns } from './present-turns'
import { finishChatRead } from '../sessions/chat-web'

const turns = (): ChatTurn[] => [
  { role: 'user', text: 'hello <meta>x</meta>' },
  { role: 'user', text: '<meta>only</meta>' },
  { role: 'assistant', text: 'hi' },
]
const fake: EnginePresentation = {
  chatTurns: ts => ts.flatMap(t => {
    const text = t.text.replace(/<meta>.*?<\/meta>/g, '').trim()
    return text === '' ? [] : [{ ...t, text }]
  }),
}

describe('presentChatTurns', () => {
  test('with no presentation it is identity (same array)', () => {
    const t = turns()
    expect(presentChatTurns(t, undefined)).toBe(t)
  })
  test('with a presentation it strips and drops emptied turns', () => {
    expect(presentChatTurns(turns(), fake).map(t => t.text)).toEqual(['hello', 'hi'])
  })
  test('a presenter that throws shows the turns as read', () => {
    const t = turns()
    expect(presentChatTurns(t, { chatTurns: () => { throw new Error('x') } })).toBe(t)
  })
  test('finishChatRead presents every legacy read; without a presenter it leaves turns alone', async () => {
    const withIt = await finishChatRead('r1', 'c1', { turns: turns() }, false, 'en', 'r1', ts => presentChatTurns(ts, fake))
    expect(withIt.turns.map(t => t.text)).toEqual(['hello', 'hi'])
    const without = await finishChatRead('r1', 'c1', { turns: turns() }, false, 'en', 'r1', ts => presentChatTurns(ts, undefined))
    expect(without.turns).toHaveLength(3)
  })
})
