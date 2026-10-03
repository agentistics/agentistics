import { describe, expect, test } from 'bun:test'
import { applyChatDelta, chatDelta } from './chatDelta'

const t = (text: string, role: 'user' | 'assistant' = 'assistant') => ({ role, text })

describe('chatDelta / applyChatDelta', () => {
  const roundTrip = (prev: object[], next: object[]) => {
    const d = chatDelta(prev.map(x => JSON.stringify(x)), next)
    return { d, rebuilt: d.kind === 'delta' ? applyChatDelta(prev, d) : next }
  }

  test('an appended turn travels alone', () => {
    const prev = [t('a', 'user'), t('b')]
    const next = [...prev, t('c', 'user')]
    const { d, rebuilt } = roundTrip(prev, next)
    expect(d).toEqual({ kind: 'delta', drop: 0, keep: 2, append: [t('c', 'user')] })
    expect(rebuilt).toEqual(next)
  })

  test('the last turn growing (an answer still being written) resends only that turn', () => {
    const prev = [t('a', 'user'), t('b')]
    const next = [t('a', 'user'), t('b and more')]
    const { d, rebuilt } = roundTrip(prev, next)
    expect(d).toEqual({ kind: 'delta', drop: 0, keep: 1, append: [t('b and more')] })
    expect(rebuilt).toEqual(next)
  })

  test('a window that slid (the 400-turn cap) drops from the front', () => {
    const prev = [t('1'), t('2'), t('3')]
    const next = [t('2'), t('3'), t('4')]
    const { d, rebuilt } = roundTrip(prev, next)
    expect(d).toEqual({ kind: 'delta', drop: 1, keep: 2, append: [t('4')] })
    expect(rebuilt).toEqual(next)
  })

  test('nothing in common, or no previous frame: the whole thing', () => {
    expect(chatDelta(null, [t('x')])).toEqual({ kind: 'full' })
    expect(chatDelta([JSON.stringify(t('a'))], [t('z')])).toEqual({ kind: 'full' })
  })

  test('unchanged is said as such', () => {
    const prev = [t('a'), t('b')]
    expect(chatDelta(prev.map(x => JSON.stringify(x)), prev)).toEqual({ kind: 'same' })
  })
})
