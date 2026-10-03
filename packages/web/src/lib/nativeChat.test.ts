import { describe, expect, test } from 'bun:test'
import {
  INITIAL_NATIVE_CHAT,
  nativeChatItems,
  nativeChatReducer,
  needsWindowRefresh,
  parseNativeFrame,
  streamFromSeq,
  type NativeChatState,
  type NativeFrame,
  type NativeWindow,
} from './nativeChat'

const RUN = 'run_1'
const TX = 'tx_aaa'

const ev = (seq: number, type: string, data: Record<string, unknown> = {}, extra: Record<string, unknown> = {}): NativeFrame =>
  ({ kind: 'event', seq, event: { type, runId: RUN, data, ...extra } })

function apply(s: NativeChatState, ...actions: Parameters<typeof nativeChatReducer>[1][]): NativeChatState {
  return actions.reduce(nativeChatReducer, s)
}

const windowWith = (messages: NativeWindow['messages'], latestRun?: NativeWindow['latestRun']): NativeWindow => ({
  session: { sessionId: 'ses_1', model: 'claude-x', provider: 'anthropic', status: 'open' },
  messages,
  ...(latestRun ? { latestRun } : {}),
})

describe('parseNativeFrame — untrusted SSE data', () => {
  test('a well-formed frame; garbage is null, never a throw', () => {
    expect(parseNativeFrame('{"kind":"delta","seq":3,"text":"hi"}')).toEqual({ kind: 'delta', seq: 3, text: 'hi' })
    expect(parseNativeFrame('not json')).toBeNull()
    expect(parseNativeFrame('{"kind":"nope"}')).toBeNull()
    expect(parseNativeFrame('[1]')).toBeNull()
  })
})

describe('nativeChatReducer + nativeChatItems — the conversation', () => {
  test('the window: user and assistant text become turns; a tool_use and its result become ONE card', () => {
    const s = apply(INITIAL_NATIVE_CHAT, { type: 'window', window: windowWith([
      { seq: 1, message: { role: 'user', content: 'read a.ts' } },
      { seq: 2, message: { role: 'assistant', content: [{ type: 'text', text: 'Reading it.' }, { type: 'tool_use', id: 'tu1', name: 'file__read', input: { path: 'a.ts' } }] } },
      { seq: 3, message: { role: 'user', content: [{ type: 'tool_result', toolUseId: 'tu1', content: 'export const a = 1' }] } },
      { seq: 4, message: { role: 'assistant', content: [{ type: 'text', text: 'Done.' }] } },
    ], { runId: RUN, status: 'completed', toolCalls: [{ toolExecutionId: TX, toolUseId: 'tu1', name: 'file.read', state: 'settled', isError: false }] }) })
    const items = nativeChatItems(s)
    expect(items.map(i => i.kind)).toEqual(['turn', 'turn', 'tool', 'turn'])
    expect(items[0]).toMatchObject({ kind: 'turn', turn: { role: 'user', text: 'read a.ts' } })
    expect(items[2]).toMatchObject({ kind: 'tool', card: { name: 'file.read', status: 'completed', detail: 'a.ts', result: 'export const a = 1', toolExecutionId: TX } })
    expect(s.running).toBe(false)
  })

  test('live: run.started → running; deltas stream into one assistant turn; run.ended → idle', () => {
    let s = apply(INITIAL_NATIVE_CHAT, { type: 'window', window: windowWith([]) })
    s = apply(s, { type: 'frame', frame: ev(1, 'run.started') }, { type: 'frame', frame: ev(2, 'model.invoked') },
      { type: 'frame', frame: { kind: 'delta', seq: 3, runId: RUN, text: 'Hel' } }, { type: 'frame', frame: { kind: 'delta', seq: 4, runId: RUN, text: 'lo' } })
    expect(s.running).toBe(true)
    expect(s.runId).toBe(RUN)
    expect(nativeChatItems(s).at(-1)).toMatchObject({ kind: 'turn', turn: { role: 'assistant', text: 'Hello', pending: true } })
    s = apply(s, { type: 'frame', frame: ev(5, 'run.ended', { status: 'completed' }) })
    expect(s.running).toBe(false)
  })

  test('the streamed text gives way to the persisted message once the window carries it — never twice', () => {
    let s = apply(INITIAL_NATIVE_CHAT, { type: 'window', window: windowWith([{ seq: 1, message: { role: 'user', content: 'hi' } }]) },
      { type: 'frame', frame: ev(1, 'run.started') }, { type: 'frame', frame: ev(2, 'model.invoked') },
      { type: 'frame', frame: { kind: 'delta', seq: 3, text: 'Hello there' } })
    s = apply(s, { type: 'window', window: windowWith([
      { seq: 1, message: { role: 'user', content: 'hi' } },
      { seq: 2, message: { role: 'assistant', content: [{ type: 'text', text: 'Hello there' }] } },
    ]) })
    expect(nativeChatItems(s).filter(i => i.kind === 'turn' && i.turn.text === 'Hello there')).toHaveLength(1)
  })

  test('a sent message shows at once (pending) and is not doubled when the window carries it', () => {
    let s = apply(INITIAL_NATIVE_CHAT, { type: 'window', window: windowWith([]) }, { type: 'sent', clientRef: 'c1', text: 'go' })
    expect(nativeChatItems(s)).toEqual([{ kind: 'turn', key: 'pending:c1', turn: { role: 'user', text: 'go', pending: true } }])
    s = apply(s, { type: 'window', window: windowWith([{ seq: 1, message: { role: 'user', content: 'go' } }]) })
    expect(nativeChatItems(s).map(i => i.kind === 'turn' && i.turn.pending)).toEqual([false])
  })

  test('a refused send is said, and the pending message goes', () => {
    const s = apply(INITIAL_NATIVE_CHAT, { type: 'sent', clientRef: 'c1', text: 'go' }, { type: 'send-failed', clientRef: 'c1', sentence: 'queue full' })
    expect(nativeChatItems(s)).toEqual([])
    expect(s.notice).toBe('queue full')
  })

  test('a tool the window has not caught up with yet is a live card from its events', () => {
    const s = apply(INITIAL_NATIVE_CHAT, { type: 'window', window: windowWith([]) },
      { type: 'frame', frame: ev(1, 'run.started') },
      { type: 'frame', frame: ev(2, 'tool.requested', { toolExecutionId: TX, name: 'shell.start', canonicalName: 'shell.start', kind: 'shell' }) })
    expect(nativeChatItems(s).at(-1)).toMatchObject({ kind: 'tool', card: { name: 'shell.start', status: 'running', toolExecutionId: TX } })
  })

  test('an ask: the card awaits approval and carries the question; an answer closes it', () => {
    let s = apply(INITIAL_NATIVE_CHAT, { type: 'window', window: windowWith([
      { seq: 1, message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tu1', name: 'shell__start', input: { command: 'rm -rf build' } }] } },
    ], { runId: RUN, status: 'running', toolCalls: [{ toolExecutionId: TX, toolUseId: 'tu1', name: 'shell.start', state: 'started' }] }) },
    { type: 'frame', frame: ev(1, 'tool.requested', { toolExecutionId: TX, name: 'shell.start' }) },
    { type: 'frame', frame: { kind: 'ask', seq: 2, question: { id: `${TX}:permission`, kind: 'permission', text: 'Run rm -rf build?', options: [{ label: 'Allow once' }, { label: 'Deny' }], subjects: [{ action: 'shell', command: 'rm -rf build', cwd: '/ws', tty: false }] } } })
    const card = nativeChatItems(s).find(i => i.kind === 'tool')!
    expect(card).toMatchObject({ card: { status: 'awaiting', detail: 'rm -rf build', ask: { questionId: `${TX}:permission`, text: 'Run rm -rf build?' } } })
    s = apply(s, { type: 'frame', frame: { kind: 'ask-closed', seq: 3, questionId: `${TX}:permission`, outcome: 'answered' } })
    expect(nativeChatItems(s).find(i => i.kind === 'tool')).toMatchObject({ card: { status: 'running' } })
    expect((nativeChatItems(s).find(i => i.kind === 'tool') as { card: { ask?: unknown } }).card.ask).toBeUndefined()
  })

  test('an ask with no card to sit on is its own approval item (a question the model asked)', () => {
    const s = apply(INITIAL_NATIVE_CHAT, { type: 'frame', frame: { kind: 'ask', seq: 1, question: { id: 'tx_zzz:q', kind: 'question', text: 'Which branch?', options: [{ label: 'main' }], allowFreeText: true } } })
    expect(nativeChatItems(s).at(-1)).toMatchObject({ kind: 'approval', ask: { questionId: 'tx_zzz:q', text: 'Which branch?', allowFreeText: true } })
  })

  test('terminal tool events set the status of a card still waiting for its result; a denial says so', () => {
    const base = apply(INITIAL_NATIVE_CHAT, { type: 'window', window: windowWith([
      { seq: 1, message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tu1', name: 'shell__start', input: { command: 'make' } }] } },
    ], { runId: RUN, status: 'running', toolCalls: [{ toolExecutionId: TX, toolUseId: 'tu1', name: 'shell.start', state: 'started' }] }) })
    const done = apply(base, { type: 'frame', frame: ev(2, 'tool.completed', { toolExecutionId: TX, exitCode: 0, durationMs: 1200 }) })
    expect(nativeChatItems(done)[0]).toMatchObject({ card: { status: 'completed', exitCode: 0, durationMs: 1200 } })
    const denied = apply(base, { type: 'frame', frame: ev(2, 'tool.denied', { toolExecutionId: TX, by: 'user' }) })
    expect(nativeChatItems(denied)[0]).toMatchObject({ card: { status: 'denied' } })
  })

  test('a frame seen twice (a reconnect replay) is applied once; the cursor moves forward only', () => {
    const d = { type: 'frame' as const, frame: { kind: 'delta' as const, seq: 5, text: 'x' } }
    const s = apply(INITIAL_NATIVE_CHAT, { type: 'frame', frame: ev(4, 'model.invoked') }, d, d)
    expect(s.liveText).toBe('x')
    expect(s.lastSeq).toBe(5)
    expect(streamFromSeq(s)).toBe(6)
    expect(streamFromSeq(INITIAL_NATIVE_CHAT)).toBeUndefined()
  })

  test('the latest run from the window: a reload mid-run still knows it is running and what to stop', () => {
    const s = apply(INITIAL_NATIVE_CHAT, { type: 'window', window: windowWith([], { runId: 'run_9', status: 'running', toolCalls: [] }) })
    expect(s.running).toBe(true)
    expect(s.runId).toBe('run_9')
  })

  test('needsWindowRefresh: the frames after which the persisted window has news', () => {
    expect(needsWindowRefresh(ev(1, 'tool.requested'))).toBe(true)
    expect(needsWindowRefresh(ev(1, 'tool.completed'))).toBe(true)
    expect(needsWindowRefresh(ev(1, 'model.completed'))).toBe(true)
    expect(needsWindowRefresh(ev(1, 'run.ended'))).toBe(true)
    expect(needsWindowRefresh({ kind: 'gap', missed: 3, resumeAt: 9 })).toBe(true)
    expect(needsWindowRefresh({ kind: 'delta', seq: 1, text: 'x' })).toBe(false)
    expect(needsWindowRefresh(ev(1, 'policy.requested'))).toBe(false)
  })
})
