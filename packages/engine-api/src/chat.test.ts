import { describe, expect, test } from 'bun:test'
import {
  CHAT_HISTORY_MAX,
  CHAT_HISTORY_PAGE,
  applyHarnessChatDeltas,
  chatHasHistory,
  chatPageLimit,
  chatSearchLimit,
  chatSearchVerdict,
  chatStatusOf,
  type ChatHistoryPage,
  type ChatSearchPage,
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

describe('1.22 — history, search and source status (optional members)', () => {
  const page = (over: Partial<ChatSearchPage> = {}): ChatSearchPage => ({
    status: 'ready', hits: [], complete: true, cursor: null, scanned: 0, snapshot: 's', sourceEpoch: 'e', ...over,
  })
  test('chatPageLimit: default 100, hard cap 500, never below 1', () => {
    expect(chatPageLimit()).toBe(CHAT_HISTORY_PAGE)
    expect(CHAT_HISTORY_PAGE).toBe(100)
    expect(CHAT_HISTORY_MAX).toBe(500)
    expect(chatPageLimit(10_000)).toBe(500)
    expect(chatPageLimit(0)).toBe(1)
    expect(chatPageLimit(Number.NaN)).toBe(100)
    expect(chatPageLimit(42.9)).toBe(42)
  })
  test('chatSearchLimit: default 20, cap 100', () => {
    expect(chatSearchLimit()).toBe(20)
    expect(chatSearchLimit(1_000)).toBe(100)
  })
  test('"no results" only for a complete scan; an incomplete or unavailable one never says it', () => {
    expect(chatSearchVerdict(page())).toBe('none')
    expect(chatSearchVerdict(page({ complete: false, stopped: 'cancelled', cursor: 'c' }))).toBe('incomplete')
    expect(chatSearchVerdict(page({ complete: false, stopped: 'budget', cursor: 'c' }))).toBe('incomplete')
    expect(chatSearchVerdict(page({ hits: [{ index: 3, role: 'user', snippet: 'x', before: 'b' }] }))).toBe('hits')
    expect(chatSearchVerdict({ status: 'error', code: 'timeout', reason: 'slow', retryable: true })).toBe('unavailable')
    expect(chatSearchVerdict({ status: 'absent', reason: 'gone' })).toBe('unavailable')
  })
  test('ready([]) and absent are different statuses', () => {
    const empty: ChatHistoryPage = { status: 'ready', turns: [], start: 0, before: null, snapshot: 's', total: 0, sourceEpoch: 'e' }
    expect(chatStatusOf(empty)).toEqual({ kind: 'ready' })
    expect(chatStatusOf({ status: 'absent', reason: 'no transcript' })).toEqual({ kind: 'absent', reason: 'no transcript' })
    expect(chatStatusOf({ status: 'pending', reason: 'first prompt', retryAfterMs: 2000 })).toEqual({ kind: 'pending', reason: 'first prompt', retryAfterMs: 2000 })
    expect(chatStatusOf({ status: 'error', code: 'epoch-changed', reason: 'rewound', retryable: true }))
      .toEqual({ kind: 'error', code: 'epoch-changed', reason: 'rewound', retryable: true })
  })
  test('chatHasHistory: all three members or none; a 1.21 chat (no members) is not history', () => {
    const base: HarnessChat = {
      declares: { state: { absent: 'x' }, attention: { absent: 'x' }, live: { absent: 'x' }, fork: { absent: 'x' } },
      resolve: async () => null,
      follow: () => () => {},
    }
    expect(chatHasHistory(base)).toBe(false)
    const unavailable = async () => ({ status: 'absent' as const, reason: 'x' })
    const full: HarnessChat = { ...base, status: async () => ({ kind: 'absent', reason: 'x' }), history: unavailable, search: unavailable }
    expect(chatHasHistory(full)).toBe(true)
    expect(chatHasHistory({ ...base, history: unavailable })).toBe(false)
    // the four 1.9 features are still the only ones chatFeaturesOf lists: history is reported on its own
    expect(chatFeaturesOf({ ...base.declares, history: { from: 'transcript' } })).toEqual([])
  })
})
