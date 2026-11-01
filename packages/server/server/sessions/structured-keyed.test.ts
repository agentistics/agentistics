/**
 * structured-keyed.test.ts — ADAPTER.LIMITES E7, the host side of the keyed members (engine-api 1.21):
 * - `calls.jsonl` holds `submit` / `amend` / `cancelRequest` (recorded by the DRIVER after its claim), always keyed;
 * - `DurableStore.recorded` / `DurableTransport.recorded` answer reconcile 1 over the record, and a record born AFTER a
 *   claim (a relaunch) cannot say "absent";
 * - `recordingSession` forwards the keyed members WITHOUT recording them (claim → record → write lives in the driver);
 * - the composite routes them (and the trailing key of answer / setMode / setModel) to the driver, and says what a
 *   terminal session can (`TUI_LIMITS`).
 * The end-to-end replay (a keyed call re-made by a re-created driver over a real relay) is the engine's per-driver
 * re-attach test, which runs the real drivers over this store.
 */
import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { StructuredDeclaration, StructuredDriver, StructuredSession, StructuredSpawn } from '@agentistics/engine-api'
import { structuredRegistry, TUI_LIMITS } from '@agentistics/engine-api'
import { recordingSession, withStructured, type StructuredProvider } from './structured-backend'
import { durableStore } from './structured-durable'
import { callByKey, isReplayCall, parseJsonl, type SessionCall } from './structured-replay'
import { structuredIntentOf } from './structured-route'
import type { BackendSpawn, SessionBackend } from './types'

const rec = (o: object) => JSON.stringify({ at: 1, t: 1, ...o })

describe('keyed calls in calls.jsonl', () => {
  test('submit / amend / cancelRequest parse only with a valid key and request id; `step` may only be `read`', () => {
    const text = [
      rec({ op: 'submit', requestId: 'R1', text: 'go', key: 'k:1' }),
      rec({ op: 'amend', requestId: 'R1', text: 'fix', key: 'k:2' }),
      rec({ op: 'cancelRequest', requestId: 'R1', key: 'k:3' }),
      rec({ op: 'submit', requestId: 'R1', text: 'go', key: 'k:4', step: 'read' }),
      rec({ op: 'submit', requestId: 'R1', text: 'no key' }),
      rec({ op: 'amend', requestId: 'R1', key: 'k:5' }), // no text
      rec({ op: 'cancelRequest', key: 'k:6' }), // no request
      rec({ op: 'submit', requestId: 'R1', text: 'x', key: 'k:7', step: 'act' }),
    ].join('\n')
    expect(parseJsonl(text, isReplayCall).map(c => c.key)).toEqual(['k:1', 'k:2', 'k:3', 'k:4'])
  })
  test('callByKey skips a reconcile read-back: it proves nothing was made', () => {
    const calls = parseJsonl([rec({ op: 'submit', requestId: 'R', text: 't', key: 'k', step: 'read' })].join('\n'), isReplayCall)
    expect(callByKey(calls, 'k')).toBeUndefined()
    const both = parseJsonl([rec({ op: 'submit', requestId: 'R', text: 't', key: 'k', step: 'read' }), rec({ op: 'submit', requestId: 'R', text: 't', key: 'k' })].join('\n'), isReplayCall)
    expect(callByKey(both, 'k')).toMatchObject({ op: 'submit' })
    expect(callByKey(both, 'k')).not.toHaveProperty('step')
  })
})

describe('recorded — reconcile 1 over the durable record', () => {
  const saved = { v: 1 as const, harness: 'codex' as const, spawn: { id: 's1', harness: 'codex' as const, cwd: '/w' }, backend: { id: 's1', cwd: '/w' } }
  test('made when the record holds the key; absent only when the record predates the claim; no-record otherwise', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'dur-recorded-'))
    try {
      const store = durableStore(root)
      expect(store.recorded('s1', 'k', new Date().toISOString())).toBe('no-record') // no record at all
      const before = new Date(Date.now() - 60_000).toISOString()
      const t = store.create('s1', saved)
      const after = new Date(Date.now() + 1).toISOString()
      t.record({ op: 'submit', requestId: 'R', text: 'go', key: 'k:made' })
      expect(t.recorded('k:made', before)).toBe('made')
      expect(store.recorded('s1', 'k:made')).toBe('made')
      // Claimed while this record was being kept, and not in it: the call never started.
      expect(t.recorded('k:other', after)).toBe('absent')
      // Claimed BEFORE this record was born (a relaunch replaced the old one): it cannot tell.
      expect(t.recorded('k:other', before)).toBe('no-record')
      expect(t.recorded('k:other')).toBe('no-record')
      // A read-back only is not "made".
      t.record({ op: 'submit', requestId: 'R', text: 'go', key: 'k:read', step: 'read' })
      expect(t.recorded('k:read', after)).toBe('absent')
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
})

/** A session with every keyed member, logging what reached it. */
function keyedSession(log: string[]): StructuredSession {
  return {
    id: 'm-1', driver: 'acp', harness: 'gemini',
    conversationId: () => 'c1', activity: () => 'waiting', attention: () => null, screen: () => [], lastActivityMs: () => 0,
    prompt: () => true,
    answer: (a, key) => { log.push(`answer:${a.choice}:${key ?? '-'}`); return true },
    setMode: async (id, key) => { log.push(`setMode:${id}:${key ?? '-'}`); return true },
    setModel: async (id, key) => { log.push(`setModel:${id}:${key ?? '-'}`); return { ok: true } },
    cancel() {},
    submit: async r => { log.push(`submit:${r.requestId}:${r.idempotencyKey}`); return { state: 'queued', requestId: r.requestId, at: 'now', durable: false } },
    amend: async (requestId, _t, key) => { log.push(`amend:${requestId}:${key}`); return { result: 'amended', how: 'replaced', requestId, at: 'now', durable: false } },
    cancelRequest: async (requestId, key) => { log.push(`cancelRequest:${requestId}:${key}`); return { state: 'cancelled', requestId, at: 'now', confidence: 'exact', scope: 'request', effects: 'none', durable: false } },
    requestState: () => 'queued',
    follow: () => () => {}, onExit: () => () => {}, dispose() {},
  }
}

describe('recordingSession — the keyed members are the driver\'s to record', () => {
  test('forwarded as they are, nothing recorded here; answer / setMode / setModel keep their key in the record', async () => {
    const log: string[] = []
    const recorded: SessionCall[] = []
    const s = recordingSession(keyedSession(log), { record: c => { recorded.push(c) } })
    await s.submit!({ requestId: 'R', idempotencyKey: 'k:s', text: 'go' })
    await s.amend!('R', 'fix', 'k:a')
    await s.cancelRequest!('R', 'k:c')
    expect(s.requestState!('R')).toBe('queued')
    expect(recorded).toEqual([])
    s.answer({ choice: 1 }, 'k:ans')
    await s.setMode!('plan', 'k:mode')
    expect(recorded.map(c => `${c.op}:${c.key}`)).toEqual(['answer:k:ans', 'setMode:k:mode'])
    expect(log).toEqual(['submit:R:k:s', 'amend:R:k:a', 'cancelRequest:R:k:c', 'answer:1:k:ans', 'setMode:plan:k:mode'])
  })
  test('a driver without them stays without them', () => {
    const { submit: _s, amend: _a, cancelRequest: _c, requestState: _r, ...bare } = keyedSession([])
    const s = recordingSession(bare as StructuredSession, { record() {} })
    expect([s.submit, s.amend, s.cancelRequest, s.requestState]).toEqual([undefined, undefined, undefined, undefined])
  })
})

const DECL: StructuredDeclaration = {
  assignId: { absent: 'fake' }, resume: { absent: 'fake' }, model: { absent: 'fake' }, effort: { absent: 'fake' },
  mcp: { absent: 'fake' }, instructions: { channel: 'first-message', reason: 'fake' }, live: { absent: 'fake' },
  permissions: { absent: 'fake' }, questions: { absent: 'fake' }, cancel: { absent: 'fake' },
  amend: { queued: { via: 'driver queue' }, running: { absent: 'a concurrent prompt aborts the turn' } },
  cancelReceipt: { via: 'session/cancel → stopReason', confidence: 'exact' },
  reconcile: { absent: 'no id' },
}

describe('the composite routes the keyed members', () => {
  async function server(log: string[]) {
    const driver: StructuredDriver = {
      id: 'acp', status: 'ready', harnesses: ['gemini'], note: 'fake', declares: () => DECL,
      async start(_req: StructuredSpawn) { return { ok: true, session: keyedSession(log) } },
    }
    const reg = structuredRegistry([driver])
    const base = {
      id: 'tmux', unavailable: async () => undefined, spawn: async () => ({}), list: async () => [],
      capture: async () => [], captureTerminal: async () => null,
      sendText: async () => true, sendTextRaw: async () => true, sendKey: async () => true, sendPaste: async () => true,
      kill: async () => true, attachCommand: (id: string) => ['tmux', 'attach', '-t', id], detachHint: async () => 'C-b d',
    } as unknown as SessionBackend
    const provider: StructuredProvider = { structured: async () => reg, acp: async () => null, allowed: async () => [], flagOn: () => true }
    const b = withStructured(base, provider)
    const req: BackendSpawn = { id: 'm-1', cwd: '/w', argv: ['/usr/bin/gemini'], structured: structuredIntentOf({ harness: 'gemini', origin: 'web' }, { conversationId: 'c' }) }
    await b.spawn(req)
    return b
  }
  test('submit / amend / cancelRequest / requestState reach the driver; any other id answers null', async () => {
    const log: string[] = []
    const b = await server(log)
    expect(await b.submitRequest!('m-1', { requestId: 'R', idempotencyKey: 'k:s', text: 'go' })).toMatchObject({ state: 'queued' })
    expect(await b.amendRequest!('m-1', 'R', 'fix', 'k:a')).toMatchObject({ result: 'amended', how: 'replaced' })
    expect(await b.cancelRequest!('m-1', 'R', 'k:c')).toMatchObject({ state: 'cancelled', confidence: 'exact' })
    expect(b.requestStateOf!('m-1', 'R')).toBe('queued')
    expect(await b.submitRequest!('tmux-1', { requestId: 'R', idempotencyKey: 'k:x', text: 'go' })).toBeNull()
    expect(b.requestStateOf!('tmux-1', 'R')).toBeNull()
    expect(log).toEqual(['submit:R:k:s', 'amend:R:k:a', 'cancelRequest:R:k:c'])
  })
  test('answer / setMode / setModel hand the caller\'s key to the driver', async () => {
    const log: string[] = []
    const b = await server(log)
    expect(await b.answer!('m-1', { choice: 1 }, 'k:ans')).toBe(true)
    expect(await b.setMode!('m-1', 'plan', 'k:mode')).toBe(true)
    expect(await b.setModel!('m-1', 'flash', 'k:model')).toEqual({ ok: true })
    expect(log).toEqual(['answer:1:k:ans', 'setMode:plan:k:mode', 'setModel:flash:k:model'])
  })
  test('limitsOf: the driver\'s declaration for a protocol session, TUI_LIMITS for a terminal one', async () => {
    const b = await server([])
    expect(b.limitsOf!('m-1')).toEqual({ amend: DECL.amend!, cancelReceipt: DECL.cancelReceipt!, reconcile: DECL.reconcile! })
    expect(b.limitsOf!('tmux-1')).toBe(TUI_LIMITS)
    expect(TUI_LIMITS.amend.queued.absent).toBeTruthy()
    expect(TUI_LIMITS.amend.running.absent).toBeTruthy()
    expect(TUI_LIMITS.cancelReceipt.confidence).toBe('inferred')
    expect(TUI_LIMITS.reconcile.absent).toBeTruthy()
  })
})
