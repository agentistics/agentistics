import { describe, expect, test } from 'bun:test'
import {
  applyHarnessChatDeltas,
  chatFeaturesOf,
  hasChat,
  type EngineChatTurn,
  type HarnessChat,
  type HarnessIntegration,
} from './index'

const t = (text: string): EngineChatTurn => ({ role: 'assistant', text })

describe('applyHarnessChatDeltas — the one definition of how a receiver applies the deltas', () => {
  test('window replaces everything, older included', () => {
    const r = applyHarnessChatDeltas({ turns: [t('a')], older: false }, [{ kind: 'window', turns: [t('x'), t('y')], older: true }], 10)
    expect(r).toEqual({ turns: [t('x'), t('y')], older: true })
  })
  test('append adds at the end and trims the front to max, which makes older true', () => {
    const r = applyHarnessChatDeltas({ turns: [t('a'), t('b')], older: false }, [{ kind: 'append', turns: [t('c')] }], 2)
    expect(r).toEqual({ turns: [t('b'), t('c')], older: true })
  })
  test('append under the cap keeps older as it was', () => {
    const r = applyHarnessChatDeltas({ turns: [t('a')], older: false }, [{ kind: 'append', turns: [t('b')] }], 5)
    expect(r).toEqual({ turns: [t('a'), t('b')], older: false })
  })
  test('grow replaces the last turn, then an append applies after it', () => {
    const r = applyHarnessChatDeltas(
      { turns: [t('a'), { role: 'assistant', text: '', pending: true }], older: false },
      [{ kind: 'grow', turn: t('done') }, { kind: 'append', turns: [t('next')] }],
      10,
    )
    expect(r.turns).toEqual([t('a'), t('done'), t('next')])
  })
  test('live, state and fork leave the turns alone', () => {
    const prev = { turns: [t('a')], older: false }
    const r = applyHarnessChatDeltas(prev, [
      { kind: 'live', text: 'typing' },
      { kind: 'state', working: true },
      { kind: 'fork', to: { harness: 'claude', conversationId: 'c', sourceRef: '/x' } },
    ], 10)
    expect(r).toEqual(prev)
  })
})

describe('the chat declaration', () => {
  test('chatFeaturesOf lists only what is present, in a fixed order', () => {
    expect(chatFeaturesOf({
      state: { from: 'transcript markers' },
      attention: { absent: 'the file never says' },
      live: { absent: 'written at message end' },
      fork: { from: 'transcript chain' },
    })).toEqual(['state', 'fork'])
  })
  test('hasChat narrows on presence; a declared absence is false, not an error', () => {
    const chat: HarnessChat = {
      declares: { state: { absent: 'x' }, attention: { absent: 'x' }, live: { absent: 'x' }, fork: { absent: 'x' } },
      resolve: async () => null,
      follow: () => () => {},
    }
    const base = { id: 'claude' as const, version: '1', capabilities: {}, replayAbsent: 'none' }
    const withChat: HarnessIntegration = { ...base, chat }
    const without: HarnessIntegration = { ...base, chatAbsent: 'no reader' }
    expect(hasChat(withChat)).toBe(true)
    expect(hasChat(without)).toBe(false)
  })
})
