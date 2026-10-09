/**
 * structured-backend.test.ts — F2.0's composite: the driver CONTRACT against a fake driver, routing
 * with the flag ON/OFF and by origin, the fallback at both ends (a refused start; a driver that fails
 * mid-life is resumed in tmux by conversation id), answering through the driver (no keystroke), and the
 * session's own chat channel. A5.4's ACP scenarios stay in `acp-backend.test.ts`, run through this module.
 */
import { describe, expect, test } from 'bun:test'
import type {
  EngineAcp, EngineStructured, HarnessChatDelta, HarnessId, StructuredAnswer, StructuredAttention,
  StructuredDeclaration, StructuredExit, StructuredSession, StructuredSpawn,
} from '@agentistics/engine-api'
import { answerFits, structuredRegistry, stubDriver } from '@agentistics/engine-api'
import { acpAsStructured, structuredSpawnOf, withStructured, type StructuredProvider } from './structured-backend'
import { answerStructured, routeSpawn, structuredIntentOf } from './structured-route'
import type { BackendSpawn, SessionBackend } from './types'

function fakeBase(): SessionBackend & { calls: Array<[string, unknown?]> } {
  const calls: Array<[string, unknown?]> = []
  const rec = <T>(name: string, v: T) => async (...a: unknown[]) => { calls.push([name, a[0]]); return v }
  return {
    calls, id: 'tmux',
    unavailable: rec('unavailable', undefined),
    spawn: rec('spawn', undefined),
    list: async () => [{ id: 't-1', createdMs: 1, attached: false, alive: true, lastActivityMs: 1 }],
    capture: rec('capture', ['tmux frame']),
    captureTerminal: rec('captureTerminal', null),
    sendText: rec('sendText', true), sendTextRaw: rec('sendTextRaw', true), sendKey: rec('sendKey', true), sendPaste: rec('sendPaste', true),
    sendChoiceText: rec('sendChoiceText', 'sent'),
    kill: rec('kill', true), attachCommand: () => ['tmux', 'attach'], detachHint: rec('detachHint', 'C-b d'),
  } as unknown as SessionBackend & { calls: Array<[string, unknown?]> }
}

const DECL: StructuredDeclaration = {
  assignId: { via: '--session-id' }, resume: { via: 'session/load' }, model: { via: 'session/set_model' },
  effort: { absent: 'no effort in this protocol' }, mcp: { via: 'mcpServers' },
  instructions: { channel: 'protocol', via: 'developerInstructions' },
  live: { via: 'agent_message_chunk' }, permissions: { via: 'request_permission' },
  questions: { via: 'question request' }, cancel: { via: 'session/cancel' },
}

/** A fake session that follows the contract: state, attention, answers, deltas, exit. */
function fakeSession(req: StructuredSpawn) {
  let state: ReturnType<StructuredSession['activity']> = 'waiting'
  let open: StructuredAttention | null = null
  const subs = new Set<(d: HarnessChatDelta) => void>()
  const exits = new Set<(e: StructuredExit) => void>()
  const s = {
    prompts: [] as string[], answers: [] as StructuredAnswer[], cancelled: 0, disposed: false,
    id: req.id, driver: 'acp' as const, harness: req.harness,
    conversationId: () => req.conversationId ?? 'conv-from-protocol',
    activity: () => state,
    attention: () => open,
    screen: (n: number) => ['> hi', 'agent: hello'].slice(-n),
    lastActivityMs: () => 7,
    prompt(t: string) { if (state === 'exited') return false; s.prompts.push(t); state = 'working'; for (const f of subs) f({ kind: 'live', text: 'thin' }); return true },
    answer(a: StructuredAnswer) { const fit = answerFits(open, a); if (!fit.ok) return false; s.answers.push(a); open = null; state = 'working'; return true },
    cancel() { s.cancelled++; open = null; state = 'waiting' },
    follow(_max: number, on: (d: HarnessChatDelta) => void) {
      on({ kind: 'window', turns: [{ role: 'user', text: req.initialPrompt ?? '' }], older: false })
      on({ kind: 'state', working: state === 'working' })
      subs.add(on)
      return () => { subs.delete(on) }
    },
    onExit(cb: (e: StructuredExit) => void) { exits.add(cb); return () => { exits.delete(cb) } },
    dispose() { s.disposed = true; state = 'exited'; for (const cb of exits) cb({ kind: 'disposed' }) },
    // test controls
    ask(a: StructuredAttention) { open = a; state = 'waiting-approval' },
    fail(reason: string) { state = 'exited'; for (const cb of exits) cb({ kind: 'failed', reason }) },
  }
  return s
}
type FakeSession = ReturnType<typeof fakeSession>

function fakeEngine(o: { harnesses?: HarnessId[]; refuse?: string } = {}) {
  const started: StructuredSpawn[] = []
  const sessions: FakeSession[] = []
  const reg = structuredRegistry([
    {
      id: 'acp', status: 'ready', harnesses: o.harnesses ?? ['gemini', 'kimi', 'copilot'], note: 'fake', declares: () => DECL,
      async start(req) {
        started.push(req)
        if (o.refuse) return { ok: false, reason: o.refuse }
        const s = fakeSession(req)
        sessions.push(s)
        return { ok: true, session: s as unknown as StructuredSession }
      },
    },
    stubDriver('claude-stream-json', ['claude'], 'F3.3', () => DECL),
    stubDriver('codex-app-server', ['codex'], 'F3.1', () => DECL),
    stubDriver('agy-stream-json', ['antigravity'], 'F3.2', () => DECL),
  ])
  return { reg, started, sessions }
}

function provider(eng: EngineStructured | null, o: Partial<StructuredProvider> = {}): StructuredProvider {
  return { structured: async () => eng, acp: async () => null, allowed: async () => [], flagOn: () => true, ...o }
}

const web = (harness: HarnessId, extra: Partial<BackendSpawn> = {}): BackendSpawn => ({
  id: 'm-1', cwd: '/w', argv: [`/usr/bin/${harness}`],
  structured: structuredIntentOf({ harness, origin: 'web', prompt: 'hi' }, {
    model: 'm', ctx: { text: 'CTX', block: '<ctx>CTX</ctx>' }, conversationId: 'offered', mcp: { command: 'agentop', args: ['mcp'] },
  }),
  ...extra,
})

describe('routeSpawn (pure)', () => {
  const base = { harness: 'gemini' as HarnessId, driver: 'acp' as const, acpDriven: false, acpOptIn: [] as string[] }
  test('structured only for a web-born spawn, flag ON, with a ready driver', () => {
    expect(routeSpawn({ ...base, flagOn: true, origin: 'web' })).toBe('structured')
    expect(routeSpawn({ ...base, flagOn: false, origin: 'web' })).toBe('tmux')
    expect(routeSpawn({ ...base, flagOn: true, origin: 'terminal' })).toBe('tmux')
    expect(routeSpawn({ ...base, flagOn: true })).toBe('tmux')
    expect(routeSpawn({ ...base, flagOn: true, origin: 'web', driver: null })).toBe('tmux')
    expect(routeSpawn({ ...base, harness: null, flagOn: true, origin: 'web' })).toBe('tmux')
  })
  test('A5.4 opt-in routes as before, flag or no flag', () => {
    expect(routeSpawn({ ...base, flagOn: false, acpDriven: true, acpOptIn: ['gemini'] })).toBe('acp-legacy')
    expect(routeSpawn({ ...base, flagOn: true, origin: 'terminal', acpDriven: true, acpOptIn: ['gemini'] })).toBe('acp-legacy')
    expect(routeSpawn({ ...base, flagOn: false, acpDriven: true, acpOptIn: ['kimi'] })).toBe('tmux')
  })
})

describe('structuredRegistry / stubDriver / answerFits (engine-api, pure)', () => {
  test('a stub keeps the interface and refuses every start in a sentence; driverFor sees only ready drivers', async () => {
    const { reg } = fakeEngine()
    expect(reg.driverFor('gemini')).toBe('acp')
    expect(reg.driverFor('claude')).toBeNull()
    expect(reg.declares('claude')).toEqual(DECL)
    expect(reg.drivers().map(d => [d.id, d.status])).toEqual([['acp', 'ready'], ['claude-stream-json', 'stub'], ['codex-app-server', 'stub'], ['agy-stream-json', 'stub']])
    const r = await reg.start({ id: 'x', harness: 'claude', cwd: '/w' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain('claude-stream-json driver is not written yet')
    expect((await reg.start({ id: 'x', harness: 'opencode' as HarnessId, cwd: '/w' })).ok).toBe(false)
  })
  test('two drivers for one harness are a conflict, never resolved by order', () => {
    const r = structuredRegistry([stubDriver('acp', ['gemini'], 'a', () => DECL), stubDriver('agy-stream-json', ['gemini'], 'b', () => DECL)])
    expect(r.conflicts).toEqual(['gemini'])
  })
  test('answerFits: stale id, missing option, text only where accepted', () => {
    const open: StructuredAttention = { requestId: 'r1', kind: 'question', options: [{ id: 'a', label: 'A' }, { id: 't', label: 'Type something', freeText: true }], freeText: true }
    expect(answerFits(null, { choice: 1 })).toEqual({ ok: false, why: 'none-open' })
    expect(answerFits(open, { requestId: 'r0', choice: 1 })).toEqual({ ok: false, why: 'stale' })
    expect(answerFits(open, { choice: 3 })).toEqual({ ok: false, why: 'no-such-option' })
    expect(answerFits(open, { choice: 1, text: 'x' })).toEqual({ ok: false, why: 'text-not-accepted' })
    expect(answerFits(open, { choice: 2, text: 'x' }).ok).toBe(true)
    expect(answerFits(open, { text: 'free' }).ok).toBe(true)
    expect(answerFits({ ...open, freeText: false }, { text: 'free' })).toEqual({ ok: false, why: 'text-not-accepted' })
  })
})

describe('withStructured — routing', () => {
  test('flag ON + web-born + ready driver: started over the protocol with everything the intent carries', async () => {
    const base = fakeBase()
    const eng = fakeEngine()
    const conv: Array<[string, string]> = []
    const b = withStructured(base, provider(eng.reg, { onConversation: (id, c) => conv.push([id, c]) }))
    await b.spawn(web('gemini'))
    expect(base.calls.map(c => c[0])).not.toContain('spawn')
    expect(eng.started).toEqual([{
      id: 'm-1', harness: 'gemini', cwd: '/w', model: 'm', conversationId: 'offered', initialPrompt: 'hi',
      instructions: { text: 'CTX', block: '<ctx>CTX</ctx>' },
      mcp: [{ name: 'agentistics', command: 'agentop', args: ['mcp'] }],
    }])
    expect(conv).toEqual([['m-1', 'offered']])
    expect(b.structuredSessions()).toEqual([{ id: 'm-1', route: 'structured', driver: 'acp' }])
    expect((await b.list()).map(s => [s.id, s.alive])).toEqual([['t-1', true], ['m-1', true]])
    expect(b.activityOf!('m-1')).toBe('waiting')
    expect(b.attentionOf!('m-1')).toBeNull()
    expect(b.attentionOf!('t-1')).toBeUndefined()
    expect(await b.sendText('m-1', 'next')).toBe(true)
    expect(eng.sessions[0]!.prompts).toEqual(['next'])
    expect(b.attachCommand('m-1').join(' ')).toContain('no terminal')
  })

  test('flag OFF, terminal-born, or no ready driver: tmux, the SAME request, and nothing asked of the engine', async () => {
    const cases: Array<[boolean, BackendSpawn]> = [
      [false, web('gemini')],
      [true, { ...web('gemini'), structured: { ...web('gemini').structured!, origin: 'terminal' } }],
      [true, { ...web('gemini'), structured: { harness: 'gemini' } }],
      [true, web('claude')], // a stub: no ready driver
    ]
    for (const [flag, req] of cases) {
      const base = fakeBase()
      const eng = fakeEngine()
      let asked = 0
      const b = withStructured(base, provider(eng.reg, { flagOn: () => flag, structured: async () => { asked++; return eng.reg } }))
      await b.spawn(req)
      expect(base.calls).toEqual([['spawn', req]])
      expect(eng.started).toEqual([])
      if (!flag || req.structured?.origin !== 'web') expect(asked).toBe(0)
      expect(b.activityOf?.('m-1')).toBeUndefined()
      expect(b.chatOf?.('m-1')).toBeUndefined()
    }
  })

  test('a 1.9 engine (Engine.acp only) still serves a web-born session structured, context as the first message', async () => {
    const started: unknown[] = []
    const acp: EngineAcp = {
      harnesses: () => ['kimi'],
      start: async req => {
        started.push(req)
        return { ok: true, session: { id: req.id, acpSessionId: 'a', activity: () => 'waiting', dialog: () => null, screen: () => [], lastActivityMs: () => 1, prompt: () => true, answer: () => true, cancel() {}, dispose() {} } }
      },
    }
    const base = fakeBase()
    const b = withStructured(base, provider(null, { acp: async () => acp }))
    await b.spawn(web('kimi'))
    expect(started).toEqual([{ id: 'm-1', harness: 'kimi', cwd: '/w', initialPrompt: '<ctx>CTX</ctx>\n\nhi' }])
    expect(base.calls.map(c => c[0])).not.toContain('spawn')
    expect(acpAsStructured(acp).declares('kimi')!.instructions.channel).toBe('first-message')
    await b.kill('m-1')
  })
})

describe('withStructured — fallback', () => {
  test('a refused structured start goes to tmux with the same request', async () => {
    const base = fakeBase()
    const eng = fakeEngine({ refuse: 'login needed' })
    const b = withStructured(base, provider(eng.reg))
    const req = web('gemini')
    await b.spawn(req)
    expect(eng.started.length).toBe(1)
    expect(base.calls).toEqual([['spawn', req]])
    expect(b.activityOf?.('m-1')).toBeUndefined()
  })

  test('a driver failing mid-life is resumed in tmux by its conversation id, under the same managed id', async () => {
    const base = fakeBase()
    const eng = fakeEngine()
    const fell: unknown[] = []
    const b = withStructured(base, provider(eng.reg, {
      resumeSpawn: async (req, conv) => ({ id: 'ignored', cwd: req.cwd, argv: ['gemini', '--resume', conv] }),
      onFallback: (id, o) => fell.push([id, o]),
    }))
    await b.spawn(web('gemini'))
    eng.sessions[0]!.fail('pipe closed')
    await new Promise(r => setTimeout(r, 0))
    await new Promise(r => setTimeout(r, 0))
    expect(base.calls).toEqual([['spawn', { id: 'm-1', cwd: '/w', argv: ['gemini', '--resume', 'offered'] }]])
    expect(fell).toEqual([['m-1', { reason: 'pipe closed', resumed: true }]])
    expect(b.structuredSessions()).toEqual([])
    // every verb is tmux's now
    expect(await b.capture('m-1', 5)).toEqual(['tmux frame'])
  })

  test('a kill (disposed) or an ordinary end is not a failure: no tmux resume', async () => {
    const base = fakeBase()
    const eng = fakeEngine()
    const b = withStructured(base, provider(eng.reg, { resumeSpawn: async () => ({ id: 'm-1', cwd: '/w', argv: ['x'] }) }))
    await b.spawn(web('gemini'))
    expect(await b.kill('m-1')).toBe(true)
    expect(eng.sessions[0]!.disposed).toBe(true)
    await new Promise(r => setTimeout(r, 0))
    expect(base.calls.map(c => c[0])).toEqual([])
  })
})

describe('withStructured — answering through the driver', () => {
  const Q: StructuredAttention = {
    requestId: 'q1', kind: 'question', prompt: 'Which?',
    options: [{ id: 'a', label: 'Only my fix' }, { id: 'b', label: 'Promote all' }, { id: 't', label: 'Type something', freeText: true }],
  }
  test('attentionOf + answer: picked by number, free text with its option, stale refused; no keystroke reaches tmux', async () => {
    const base = fakeBase()
    const eng = fakeEngine()
    const b = withStructured(base, provider(eng.reg))
    await b.spawn(web('gemini'))
    const s = eng.sessions[0]!
    s.ask(Q)
    expect(b.activityOf!('m-1')).toBe('waiting-approval')
    expect(b.dialogOf!('m-1')).toEqual(['Only my fix', 'Promote all', 'Type something'])
    expect(b.attentionOf!('m-1')).toEqual(Q)
    expect(await b.answer!('m-1', { requestId: 'stale', choice: 1 })).toBe(false)
    expect(await b.answer!('m-1', { requestId: 'q1', choice: 2 })).toBe(true)
    s.ask(Q)
    expect(await b.sendChoiceText!('m-1', '3', 'jabuticaba', () => true)).toBe('sent')
    s.ask(Q)
    expect(await b.sendKey('m-1', '1')).toBe(true)
    expect(s.answers).toEqual([{ requestId: 'q1', choice: 2 }, { choice: 3, text: 'jabuticaba' }, { choice: 1 }])
    expect(await b.sendKey('m-1', 'Escape')).toBe(true)
    expect(s.cancelled).toBe(1)
    expect(base.calls).toEqual([])
  })

  test('answerStructured (pure): the screen path\'s refusals, kept', () => {
    expect(answerStructured(null, 1, undefined)).toEqual({ ok: false, why: 'not-asking' })
    expect(answerStructured(Q, undefined, undefined)).toEqual({ ok: false, why: 'needs-choice' })
    expect(answerStructured(Q, 9, undefined)).toEqual({ ok: false, why: 'gone' })
    expect(answerStructured(Q, 3, '  ')).toEqual({ ok: false, why: 'needs-text' })
    expect(answerStructured(Q, 3, ' capivara ')).toEqual({ ok: true, answer: { requestId: 'q1', choice: 3, text: 'capivara' }, said: 'capivara' })
    expect(answerStructured(Q, 1, 'ignored')).toEqual({ ok: true, answer: { requestId: 'q1', choice: 1 }, said: 'Only my fix' })
    expect(answerStructured({ ...Q, options: [], freeText: true }, undefined, 'free')).toEqual({ ok: true, answer: { requestId: 'q1', text: 'free' }, said: 'free' })
  })
})

describe('withStructured — the session is its own chat source', () => {
  test('chatOf follows the protocol: window, state, live', async () => {
    const base = fakeBase()
    const eng = fakeEngine()
    const b = withStructured(base, provider(eng.reg))
    await b.spawn(web('gemini'))
    const own = b.chatOf!('m-1')!
    expect(own.conversationId).toBe('offered')
    expect(own.chat.declares.live).toEqual({ from: 'agent_message_chunk' })
    const src = await own.chat.resolve({ conversationId: own.conversationId })
    expect(src).toEqual({ harness: 'gemini', conversationId: 'offered', sourceRef: 'structured:acp:m-1' })
    const got: HarnessChatDelta[] = []
    const off = own.chat.follow(src!, 50, d => got.push(d))
    await b.sendText('m-1', 'go')
    off()
    await b.sendText('m-1', 'after')
    expect(got).toEqual([
      { kind: 'window', turns: [{ role: 'user', text: 'hi' }], older: false },
      { kind: 'state', working: false },
      { kind: 'live', text: 'thin' },
    ])
  })
})

describe('structuredSpawnOf (pure)', () => {
  test('a resume carries no assigned id and no context; a bare argv-only request keeps its initial prompt', () => {
    const r = structuredSpawnOf({ ...web('kimi'), structured: structuredIntentOf({ harness: 'kimi', origin: 'web', resumeId: 'c9' }, { ctx: { text: 'x', block: 'y' }, conversationId: 'o' }) }, 'kimi')
    expect(r).toEqual({ id: 'm-1', harness: 'kimi', cwd: '/w', resumeId: 'c9' })
    expect(structuredSpawnOf({ id: 'a', cwd: '/w', argv: ['kimi'], initialPrompt: { text: 'p' } as never }, 'kimi')).toEqual({ id: 'a', harness: 'kimi', cwd: '/w', initialPrompt: 'p' })
  })
})
