import { describe, expect, test } from 'bun:test'
import { sessionActions } from '@agentistics/tui/control/session-verbs'
import { controlStrings } from '@agentistics/tui/control/i18n'
import { fleetRow } from './fleet-row'
import { parseSessionArgs } from './cli-parse'
import {
  isNativeSessionId, loadNativeFleet, withNativeUsage, nativeControlSessions, nativeState, nativeVerbCall, nativeVerbResult,
  resolveNativeRef, runNativeVerb, type NativeListRecord,
} from './native-fleet'

const ID = 'ses_' + '6dc83d99'.padEnd(32, '0')
const ID2 = 'ses_' + '6dc8ffff'.padEnd(32, '1')
const rec = (over: Partial<NativeListRecord> = {}): NativeListRecord => ({
  sessionId: ID, title: 'fix it', model: 'claude-sonnet-4-6', status: 'open', cwd: '/home/u/repo',
  createdAt: '2026-10-03T10:00:00.000Z', updatedAt: '2026-10-03T10:30:00.000Z', ...over,
})

describe('nativeState', () => {
  test('the activity is the engine measurement; an unmeasured open session is unknown, never working', () => {
    expect(nativeState({ status: 'open', activity: 'working' })).toBe('working')
    expect(nativeState({ status: 'open', activity: 'waiting-approval' })).toBe('waiting-approval')
    expect(nativeState({ status: 'open', activity: 'waiting' })).toBe('waiting')
    expect(nativeState({ status: 'open' })).toBe('unknown')
    expect(nativeState({ status: 'ended', activity: 'working' })).toBe('closed')
    expect(nativeState({ status: 'failed' })).toBe('closed')
  })
})

describe('nativeControlSessions', () => {
  test('maps to cockpit rows of the native harness', () => {
    const [row] = nativeControlSessions([rec({ activity: 'waiting' })], 'en')
    expect(row!.harness).toBe('agentistics')
    expect(row!.project).toBe('repo')
    expect(row!.conversationId).toBe(ID)
    expect(row!.named).toBe(true)
    expect(row!.state).toBe('waiting')
    expect(row!.resume).toBeUndefined()
  })
  test('a closed session carries its reopen target — itself', () => {
    const [row] = nativeControlSessions([rec({ status: 'ended' })], 'pt')
    expect(row!.state).toBe('closed')
    expect(row!.resume).toEqual({ sessionId: ID, title: 'fix it' })
    expect(row!.endedAt).toBe(Date.parse('2026-10-03T10:30:00.000Z'))
  })
  test('an open unmeasured session says "open", not a guessed state', () => {
    expect(nativeControlSessions([rec()], 'en')[0]!.stateLabel).toBe('open')
    expect(nativeControlSessions([rec()], 'pt')[0]!.stateLabel).toBe('aberta')
  })
  test('archived, malformed and duplicate records are left out; archived ones on request', () => {
    const list = [rec(), rec(), rec({ sessionId: 'nope' }), rec({ sessionId: ID2, archivedAt: '2026-10-03T11:00:00.000Z' })]
    expect(nativeControlSessions(list, 'en').map(r => r.id)).toEqual([ID])
    expect(nativeControlSessions(list, 'en', { includeArchived: true }).map(r => r.id)).toEqual([ID, ID2])
  })
  test('an untitled session is titled by its model and is not "named"', () => {
    const [row] = nativeControlSessions([rec({ title: '' })], 'en')
    expect(row!.title).toBe('claude-sonnet-4-6')
    expect(row!.named).toBeUndefined()
  })
})

describe('sessionActions on a native row', () => {
  test('open: rename and end are offered; attach, prompt, approve, note, task are dimmed — never dropped', () => {
    const [row] = nativeControlSessions([rec({ activity: 'working' })], 'en')
    const verbs = Object.fromEntries(sessionActions(row).map(a => [a.action, a.enabled]))
    expect(verbs.attach).toBeUndefined()
    expect(verbs).toMatchObject({ resume: false, approve: false, prompt: false, rename: true, note: false, task: false, kill: true })
  })
  test('closed: reopen is offered, end is not', () => {
    const [row] = nativeControlSessions([rec({ status: 'ended' })], 'en')
    const verbs = Object.fromEntries(sessionActions(row).map(a => [a.action, a.enabled]))
    expect(verbs).toMatchObject({ resume: true, kill: false, rename: true })
  })
})

describe('nativeVerbCall', () => {
  test('each verb is the engine route that performs it', () => {
    expect(nativeVerbCall(ID, 'kill')).toEqual({ path: `/api/runtime/sessions/${ID}/end`, init: { method: 'POST' } })
    expect(nativeVerbCall(ID, 'resume').path).toEndWith('/reopen')
    expect(nativeVerbCall(ID, 'archive').path).toEndWith('/archive')
    expect(nativeVerbCall(ID, 'unarchive').path).toEndWith('/unarchive')
    expect(nativeVerbCall(ID, 'delete')).toEqual({ path: `/api/runtime/sessions/${ID}`, init: { method: 'DELETE' } })
    const r = nativeVerbCall(ID, 'rename', 'new name')
    expect(r.init.method).toBe('PATCH')
    expect(JSON.parse(String(r.init.body))).toEqual({ title: 'new name' })
  })
})

describe('nativeVerbResult', () => {
  test('the engine sentence passes through, on success and on refusal', () => {
    expect(nativeVerbResult('kill', 200, { ended: true }, 'en')).toEqual({ ok: true, message: 'Session ended.' })
    expect(nativeVerbResult('kill', 200, { ended: false, sentence: 'Session x is already ended.' }, 'en'))
      .toEqual({ ok: true, message: 'Session x is already ended.' })
    expect(nativeVerbResult('delete', 409, { code: 'run_in_progress', sentence: 'A run of this session is in progress; end the session first.' }, 'en'))
      .toEqual({ ok: false, message: 'A run of this session is in progress; end the session first.' })
    expect(nativeVerbResult('rename', 403, { error: 'experimental' }, 'pt').message).toContain('experimental')
    expect(nativeVerbResult('resume', 500, null, 'en')).toEqual({ ok: false, message: 'The native runtime refused this (HTTP 500).' })
  })
})

describe('resolveNativeRef', () => {
  const rows = nativeControlSessions([rec(), rec({ sessionId: ID2 })], 'en')
  test('exact or a unique prefix; a shared prefix names neither; a managed handle is never captured', () => {
    expect(resolveNativeRef(rows, ID)).toMatchObject({ ok: true, id: ID })
    expect(resolveNativeRef(rows, 'ses_6dc83')).toMatchObject({ ok: true, id: ID })
    expect(resolveNativeRef(rows, 'ses_6dc8')).toMatchObject({ ok: false, reason: 'ambiguous' })
    expect(resolveNativeRef(rows, 'ses_ffff')).toMatchObject({ ok: false, reason: 'not-found' })
    expect(resolveNativeRef(rows, '6dc8')).toMatchObject({ ok: false, reason: 'not-native' })
  })
})

describe('isNativeSessionId', () => {
  test('only the engine shape', () => {
    expect(isNativeSessionId(ID)).toBe(true)
    expect(isNativeSessionId('ses_xyz')).toBe(false)
    expect(isNativeSessionId('3f5f21a8b0c1')).toBe(false)
    expect(isNativeSessionId(undefined)).toBe(false)
  })
})

describe('the I/O seam', () => {
  const answer = (status: number, body: unknown) => async () => new Response(JSON.stringify(body), { status })
  test('loadNativeFleet: gated off / central / failing engine → no rows, never a throw', async () => {
    const ok = answer(200, { sessions: [rec()] })
    expect(await loadNativeFleet('en', { on: false, central: false, ask: ok })).toEqual([])
    expect(await loadNativeFleet('en', { on: true, central: true, ask: ok })).toEqual([])
    expect(await loadNativeFleet('en', { on: true, central: false, ask: async () => null })).toEqual([])
    expect(await loadNativeFleet('en', { on: true, central: false, ask: async () => { throw new Error('x') } })).toEqual([])
    expect((await loadNativeFleet('en', { on: true, central: false, ask: ok })).map(r => r.id)).toEqual([ID])
  })
  test('loadNativeFleet asks for archived sessions only when told to', async () => {
    const asked: string[] = []
    await loadNativeFleet('en', { on: true, central: false, includeArchived: true, ask: async p => { asked.push(p); return null } })
    expect(asked.some(p => p.includes('archived=all'))).toBe(true)
    asked.length = 0
    await loadNativeFleet('en', { on: true, central: false, ask: async p => { asked.push(p); return null } })
    expect(asked.some(p => p.includes('archived='))).toBe(false)
  })
  test('runNativeVerb: every refusal is a sentence', async () => {
    expect((await runNativeVerb(ID, 'kill', 'en', { central: true })).message).toContain('central')
    expect((await runNativeVerb(ID, 'kill', 'en', { central: false, on: false })).message).toContain('experimental')
    expect((await runNativeVerb(ID, 'rename', 'en', { central: false, on: true, title: '  ' })).message).toBe('A name is required.')
    expect((await runNativeVerb(ID, 'kill', 'en', { central: false, on: true, ask: async () => null })).message).toContain('not available')
    let call: { path: string; method?: string } | null = null
    const out = await runNativeVerb(ID, 'kill', 'en', { central: false, on: true, ask: async (p, i) => { call = { path: p, method: i?.method }; return new Response(JSON.stringify({ ended: true }), { status: 200 }) } })
    expect(out).toEqual({ ok: true, message: 'Session ended.' })
    expect(call!).toEqual({ path: `/api/runtime/sessions/${ID}/end`, method: 'POST' })
  })
})

describe('fleetRow on a native row', () => {
  test('no attach command, and every dimmed verb says why in native words — never "started outside agentop"', () => {
    const c = controlStrings('en')
    const row = fleetRow(nativeControlSessions([rec({ activity: 'working' })], 'en')[0]!, c)
    expect(row.attachCommand).toBe('')
    expect(row.harness).toBe('agentistics')
    // archive/delete carry their own reason (end the session first) — tested below.
    const off = row.verbs.filter(v => !v.enabled && !['reopenFell', 'resume', 'archive', 'delete'].includes(v.action))
    expect(off.length).toBeGreaterThan(0)
    for (const v of off) expect(v.reason).toBe(c.sessionsNativeNote)
    expect(row.verbs.find(v => v.action === 'kill')!.enabled).toBe(true)
    expect(row.verbs.find(v => v.action === 'rename')!.enabled).toBe(true)
  })
})

describe('withNativeUsage', () => {
  const meta = (model: string) => ({
    session_id: ID, harness: 'agentistics', model, input_tokens: 1000, output_tokens: 500,
    cache_read_input_tokens: 2000, cache_creation_input_tokens: 0,
    model_usage: { [model]: { inputTokens: 1000, outputTokens: 500, cacheReadInputTokens: 2000, cacheCreationInputTokens: 0, webSearchRequests: 0, costUSD: 0 } },
  }) as never
  test('all four counters; a priced model gets a cost', () => {
    const [row] = withNativeUsage(nativeControlSessions([rec()], 'en'), [meta('claude-sonnet-4-6')])
    expect(row!.tokens).toBe('3.5K')
    expect(row!.cost).toBeDefined()
  })
  test('an UNPRICED model leaves the cost cell empty — never $0 — while its tokens still count', () => {
    const [row] = withNativeUsage(nativeControlSessions([rec()], 'en'), [meta('aion-labs/aion-2.0')])
    expect(row!.tokens).toBe('3.5K')
    expect(row!.cost).toBeUndefined()
  })
  test('a session the facts do not carry is left as it was', () => {
    const rows = nativeControlSessions([rec()], 'en')
    expect(withNativeUsage(rows, [])).toEqual(rows)
  })
})

describe('archive and delete — native rows only, and only once ended', () => {
  const c = controlStrings('pt')
  test('an open native row lists both, disabled, with the reason', () => {
    const row = fleetRow(nativeControlSessions([rec({ activity: 'waiting' })], 'pt')[0]!, c)
    for (const a of ['archive', 'delete']) {
      const v = row.verbs.find(x => x.action === a)!
      expect(v.enabled).toBe(false)
      expect(v.reason).toBe(c.sessionsEndFirst)
    }
  })
  test('an ended native row offers both', () => {
    const row = fleetRow(nativeControlSessions([rec({ status: 'ended' })], 'pt')[0]!, c)
    expect(row.verbs.find(x => String(x.action) === 'archive')!.enabled).toBe(true)
    expect(row.verbs.find(x => String(x.action) === 'delete')!.enabled).toBe(true)
    expect(row.verbs.find(x => String(x.action) === 'archive')!.label).toBe('Arquivar')
  })
  test('a pane session never carries them', () => {
    const pane = { ...nativeControlSessions([rec({ status: 'ended' })], 'pt')[0]!, id: '3f5f21a8b0c1', harness: 'claude' }
    const row = fleetRow(pane, c)
    expect(row.verbs.some(x => String(x.action) === 'archive' || String(x.action) === 'delete')).toBe(false)
  })
  test('the CLI parses archive / unarchive / delete with a ref, and refuses one without', () => {
    expect(parseSessionArgs(['archive', 'ses_6dc8'])).toEqual({ kind: 'archive', ref: 'ses_6dc8' })
    expect(parseSessionArgs(['unarchive', 'ses_6dc8'])).toEqual({ kind: 'unarchive', ref: 'ses_6dc8' })
    expect(parseSessionArgs(['delete', 'ses_6dc8'])).toEqual({ kind: 'delete', ref: 'ses_6dc8' })
    expect(parseSessionArgs(['delete']).kind).toBe('error')
  })
  test('runNativeVerb routes archive / unarchive / delete to the engine', async () => {
    const seen: string[] = []
    const ask = async (p: string, i?: RequestInit) => { seen.push(`${i?.method} ${p}`); return new Response('{}', { status: 200 }) }
    expect((await runNativeVerb(ID, 'archive', 'pt', { central: false, on: true, ask })).message).toBe('Sessão arquivada.')
    expect((await runNativeVerb(ID, 'unarchive', 'pt', { central: false, on: true, ask })).ok).toBe(true)
    expect((await runNativeVerb(ID, 'delete', 'pt', { central: false, on: true, ask })).message).toBe('Sessão apagada.')
    expect(seen).toEqual([`POST /api/runtime/sessions/${ID}/archive`, `POST /api/runtime/sessions/${ID}/unarchive`, `DELETE /api/runtime/sessions/${ID}`])
  })
})
