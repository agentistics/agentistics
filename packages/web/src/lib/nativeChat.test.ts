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

describe('across runs (e2e findings)', () => {
  const firstRun = windowWith([
    { seq: 1, message: { role: 'user', content: 'go' } },
    { seq: 2, message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tu1', name: 'shell__start', input: { command: 'make' } }] } },
    { seq: 3, message: { role: 'user', content: [{ type: 'tool_result', toolUseId: 'tu1', content: 'ok' }] } },
    { seq: 4, message: { role: 'assistant', content: [{ type: 'text', text: 'Done.' }] } },
  ], { runId: RUN, status: 'completed', toolCalls: [{ toolExecutionId: TX, toolUseId: 'tu1', name: 'shell.start', state: 'settled' }] })

  test('an earlier run’s call is never a ghost card, and keeps its facts, once a newer run is the latest', () => {
    let s = apply(INITIAL_NATIVE_CHAT, { type: 'window', window: firstRun },
      { type: 'frame', frame: ev(1, 'run.started') },
      { type: 'frame', frame: ev(2, 'tool.requested', { toolExecutionId: TX, name: 'shell.start' }) },
      { type: 'frame', frame: ev(3, 'tool.completed', { toolExecutionId: TX, exitCode: 0, durationMs: 630 }) },
      { type: 'frame', frame: ev(4, 'run.ended', { status: 'completed' }) })
    s = apply(s, { type: 'frame', frame: { kind: 'event', seq: 5, event: { type: 'run.started', runId: 'run_2', data: {} } } },
      { type: 'window', window: { ...firstRun, messages: [...firstRun.messages, { seq: 5, message: { role: 'user', content: 'again' } }], latestRun: { runId: 'run_2', status: 'running', toolCalls: [] } } })
    const tools = nativeChatItems(s).filter(i => i.kind === 'tool')
    expect(tools).toHaveLength(1)
    expect(tools[0]).toMatchObject({ card: { status: 'completed', exitCode: 0, durationMs: 630 } })
  })

  test('a stopped answer keeps what was written, marked as stopped, until the next run', () => {
    let s = apply(INITIAL_NATIVE_CHAT, { type: 'window', window: windowWith([{ seq: 1, message: { role: 'user', content: 'long' } }]) },
      { type: 'frame', frame: ev(1, 'run.started') }, { type: 'frame', frame: ev(2, 'model.invoked') },
      { type: 'frame', frame: { kind: 'delta', seq: 3, text: 'word1 word2' } },
      { type: 'frame', frame: ev(4, 'run.ended', { status: 'abandoned' }) })
    expect(s.running).toBe(false)
    expect(nativeChatItems(s).at(-1)).toMatchObject({ kind: 'turn', key: 'stopped', stopped: true, turn: { role: 'assistant', text: 'word1 word2' } })
    s = apply(s, { type: 'frame', frame: { kind: 'event', seq: 5, event: { type: 'run.started', runId: 'run_3', data: {} } } })
    expect(nativeChatItems(s).some(i => i.key === 'stopped')).toBe(false)
  })
})

describe('the live text and a stale window (e2e finding: a refresh landing after model.invoked)', () => {
  test('a late window carrying the PREVIOUS answer does not hide the answer being streamed now', () => {
    const before = windowWith([
      { seq: 1, message: { role: 'user', content: 'first' } },
      { seq: 2, message: { role: 'assistant', content: [{ type: 'text', text: 'one' }] } },
      { seq: 3, message: { role: 'user', content: 'second' } },
    ])
    let s = apply(INITIAL_NATIVE_CHAT, { type: 'window', window: before },
      { type: 'frame', frame: ev(1, 'run.started') }, { type: 'frame', frame: ev(2, 'model.invoked') },
      { type: 'frame', frame: { kind: 'delta', seq: 3, text: 'word1 word2' } })
    // the refresh scheduled by the previous run lands now, with an older answer appended
    s = apply(s, { type: 'window', window: { ...before, messages: [...before.messages, { seq: 4, message: { role: 'assistant', content: [{ type: 'text', text: 'late previous answer' }] } }] } })
    expect(nativeChatItems(s).at(-1)).toMatchObject({ kind: 'turn', key: 'live', turn: { text: 'word1 word2' } })
  })
})

describe('a stream joined mid-answer (e2e finding: the wizard sends before the page connects)', () => {
  test('the partial live text gives way to the persisted message that contains it — no duplicate', () => {
    let s = apply(INITIAL_NATIVE_CHAT, { type: 'window', window: windowWith([{ seq: 1, message: { role: 'user', content: 'go' } }]) },
      { type: 'frame', frame: { kind: 'delta', seq: 7, text: 'the file with a shell command.' } })
    s = apply(s, { type: 'window', window: windowWith([
      { seq: 1, message: { role: 'user', content: 'go' } },
      { seq: 2, message: { role: 'assistant', content: [{ type: 'text', text: 'I will create the file with a shell command.' }] } },
    ]) })
    expect(nativeChatItems(s).filter(i => i.kind === 'turn' && i.turn.role === 'assistant')).toHaveLength(1)
  })
})

describe('running, when the stream joined after run.started (e2e finding)', () => {
  test('the window’s running run makes the session running (Stop shows); the window seeing it end stops it', () => {
    let s = apply(INITIAL_NATIVE_CHAT, { type: 'window', window: windowWith([]) },
      { type: 'frame', frame: { kind: 'delta', seq: 9, text: 'x' } })
    expect(s.running).toBe(false)
    s = apply(s, { type: 'window', window: windowWith([], { runId: 'run_7', status: 'running', toolCalls: [] }) })
    expect(s.running).toBe(true)
    expect(s.runId).toBe('run_7')
    s = apply(s, { type: 'window', window: windowWith([], { runId: 'run_7', status: 'completed', toolCalls: [] }) })
    expect(s.running).toBe(false)
  })
})

describe('attachments in the conversation (UI follow-up 3)', () => {
  test('a user message\'s attachments are views at the engine URL, by ref; a pending send shows its previews', () => {
    const w = windowWith([
      { seq: 1, message: { role: 'user', content: [{ type: 'text', text: 'look' }, { type: 'image', mediaType: 'image/png', data: '', ref: 'abc', name: 'x-shot.png' }] } },
      { seq: 2, message: { role: 'user', content: [{ type: 'document', mediaType: 'application/pdf', data: '', ref: 'def', name: 'x-spec.pdf' }] } },
    ])
    let s = nativeChatReducer(INITIAL_NATIVE_CHAT, { type: 'window', window: w })
    s = nativeChatReducer(s, { type: 'sent', clientRef: 'c1', text: '', attachments: [{ url: '/prev', mediaType: 'image/png', name: 'y.png' }] })
    const turns = nativeChatItems(s).filter(i => i.kind === 'turn') as Extract<ReturnType<typeof nativeChatItems>[number], { kind: 'turn' }>[]
    expect(turns.map(t => [t.turn.text, t.attachments?.map(a => a.url)])).toEqual([
      ['look', ['/api/runtime/sessions/ses_1/attachments/abc']],
      ['', ['/api/runtime/sessions/ses_1/attachments/def']],
      ['', ['/prev']],
    ])
  })
})

describe('the REASONING channel (TOOLS-NATIVE item 5) — folded above the answer, never in it', () => {
  const R = (seq: number, text: string): NativeFrame => ({ kind: 'reasoning', seq, runId: RUN, text })
  const user = { seq: 1, message: { role: 'user' as const, content: 'price?' } }
  test('parsed, accumulated per run, carried on the live turn — the answer text stays clean', () => {
    expect(parseNativeFrame('{"kind":"reasoning","seq":4,"text":"hmm"}')).toEqual({ kind: 'reasoning', seq: 4, text: 'hmm' })
    const s = apply(INITIAL_NATIVE_CHAT, { type: 'window', window: windowWith([user]) },
      { type: 'frame', frame: ev(1, 'run.started') }, { type: 'frame', frame: R(2, 'The user ') }, { type: 'frame', frame: R(3, 'asks a price.') },
      { type: 'frame', frame: { kind: 'delta', seq: 4, runId: RUN, text: 'It is $3.' } })
    const live = nativeChatItems(s).find(i => i.kind === 'turn' && i.key === 'live')
    expect(live).toMatchObject({ turn: { text: 'It is $3.', reasoning: 'The user asks a price.' } })
  })
  test('still thinking, nothing written yet: a live turn with the reasoning only', () => {
    const s = apply(INITIAL_NATIVE_CHAT, { type: 'window', window: windowWith([user]) },
      { type: 'frame', frame: ev(1, 'run.started') }, { type: 'frame', frame: R(2, 'planning') })
    expect(nativeChatItems(s).at(-1)).toMatchObject({ key: 'live', turn: { text: '', reasoning: 'planning' } })
  })
  test('once the answer is persisted, the reasoning folds above THAT answer; a new run starts clean', () => {
    const answered = windowWith([user, { seq: 2, message: { role: 'assistant', content: 'It is $3.' } }])
    let s = apply(INITIAL_NATIVE_CHAT, { type: 'window', window: windowWith([user]) },
      { type: 'frame', frame: ev(1, 'run.started') }, { type: 'frame', frame: R(2, 'thought') },
      { type: 'frame', frame: { kind: 'delta', seq: 3, runId: RUN, text: 'It is $3.' } },
      { type: 'frame', frame: ev(4, 'run.ended', { status: 'completed' }) }, { type: 'window', window: answered })
    const turns = nativeChatItems(s).filter(i => i.kind === 'turn')
    expect(turns.at(-1)).toMatchObject({ turn: { role: 'assistant', text: 'It is $3.', reasoning: 'thought' } })
    s = apply(s, { type: 'frame', frame: ev(5, 'run.started', {}, { runId: 'run_2' }) })
    expect(nativeChatItems(s).some(i => i.kind === 'turn' && i.turn.reasoning)).toBe(false)
  })
})

describe('message time — the store\'s own, never invented', () => {
  test('a window message with createdAt carries it as the turn\'s `at`; one without carries none', () => {
    const s = apply(INITIAL_NATIVE_CHAT, { type: 'window', window: windowWith([
      { seq: 1, createdAt: '2026-10-04T13:05:00.000Z', message: { role: 'user', content: 'hi' } },
      { seq: 2, message: { role: 'assistant', content: 'hello' } },
    ]) })
    const turns = nativeChatItems(s).filter(i => i.kind === 'turn')
    expect(turns[0]).toMatchObject({ turn: { text: 'hi', at: '2026-10-04T13:05:00.000Z' } })
    expect('at' in (turns[1] as { turn: object }).turn).toBe(false)
  })
})
