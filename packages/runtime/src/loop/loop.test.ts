/**
 * loop.test.ts — the tool loop, fully OFFLINE: a scripted `ProviderClient` (streaming and not)
 * emits the tool calls, probe tools built with `defineTool` record what really ran, and an in-memory
 * journal receives every event.
 */
import { describe, expect, test } from 'bun:test'
import {
  classifyProviderError,
  fromAnthropicStopReason,
  fromAnthropicUsage,
  type AgentisticsEvent,
} from '@agentistics/core'
import type {
  CredentialRef,
  InvocationResult,
  ProviderClient,
  ProviderContent,
  ProviderMessage,
  ProviderMessagePart,
  ProviderRequest,
  ProviderStreamEvent,
  ToolCallFailure,
} from '../provider/client.ts'
import type { ProviderJournalSink } from '../provider/emit.ts'
import type { Tool } from '../tools/contract.ts'
import { defineTool } from '../tools/define.ts'
import { memoryContent, scriptedAsker, scriptedPolicy } from '../tools/testing.ts'
import { runToolLoop, type ToolLoopOptions } from './loop.ts'
import { buildWireTable, toWireName } from './wire.ts'

const SECRET = 'SECRET-MARKER-7f3a'

// ── Doubles ─────────────────────────────────────────────────────────────────────────────────────

function memoryJournal(): ProviderJournalSink & { events: AgentisticsEvent[]; duplicates: number } {
  const events: AgentisticsEvent[] = []
  const seen = new Set<string>()
  const sink = {
    events,
    duplicates: 0,
    async append(batch: readonly AgentisticsEvent[]) {
      let written = 0
      let duplicates = 0
      for (const e of batch) {
        if (seen.has(e.eventId)) { duplicates += 1; continue }
        seen.add(e.eventId); events.push(e); written += 1
      }
      sink.duplicates += duplicates
      return { written, duplicates }
    },
  }
  return sink
}

type Turn =
  | { content: ProviderContent[]; stop: 'end_turn' | 'tool_use' | 'max_tokens'; failures?: ToolCallFailure[] }
  | { fail: 'invalid-request' }
  /** never answers until the request's signal aborts */
  | { hang: true }

let msgCounter = 0

function scriptedClient(turns: Turn[], streaming: boolean): ProviderClient & { requests: ProviderRequest[] } {
  const requests: ProviderRequest[] = []
  const answer = async (req: ProviderRequest, attempt: number): Promise<InvocationResult> => {
    const base = {
      invocationId: req.correlation.invocationId, attempt, provider: 'anthropic' as const,
      requestedModel: req.model, startedAt: '2026-09-27T12:00:00.000Z', latencyMs: 5,
    }
    const t = turns.shift()
    if (!t) throw new Error('script exhausted')
    if ('hang' in t) {
      await new Promise<void>(resolve => {
        if (req.signal?.aborted) return resolve()
        req.signal?.addEventListener('abort', () => resolve(), { once: true })
      })
      return { ...base, status: 'failed', error: classifyProviderError({ transport: 'aborted' }) }
    }
    if ('fail' in t) return { ...base, status: 'failed', error: classifyProviderError({ httpStatus: 400 }) }
    msgCounter += 1
    return {
      ...base,
      status: 'completed',
      messageId: `msg_${msgCounter}`,
      servedModel: req.model,
      usage: fromAnthropicUsage({ input_tokens: 10, output_tokens: 5 }).usage,
      usageAnomalies: [],
      stopReason: fromAnthropicStopReason(t.stop),
      content: t.content,
      ...(streaming ? { toolCallFailures: t.failures ?? [] } : {}),
    }
  }
  const client: ProviderClient & { requests: ProviderRequest[] } = {
    requests,
    provider: 'anthropic',
    adapterVersion: 'stub@1',
    capabilities: { streaming, editPolicy: 'verbatim' as never },
    async invokeOnce(req, attempt) {
      requests.push(structuredClone({ ...req, signal: undefined }))
      return answer(req, attempt)
    },
  }
  if (streaming) {
    client.stream = async function* (req, attempt): AsyncGenerator<ProviderStreamEvent> {
      requests.push(structuredClone({ ...req, signal: undefined }))
      const r = await answer(req, attempt)
      if (r.status === 'completed') {
        yield { type: 'started', messageId: r.messageId, servedModel: r.servedModel }
        let index = 0
        for (const b of r.content) {
          if (b.type === 'text') yield { type: 'text-delta', index, text: b.text }
          if (b.type === 'tool_use') yield { type: 'tool-call', index, id: b.id, name: b.name, input: b.input }
          index += 1
        }
        for (const f of r.toolCallFailures ?? []) yield { type: 'tool-call-failed', failure: f }
      }
      yield { type: 'end', result: r }
    }
  }
  return client
}

function probes() {
  const ran: string[] = []
  const effects: string[] = []
  const order: string[] = []
  const echo = defineTool<{ text: string; delayMs?: number }>({
    name: 'probe.echo',
    description: 'echo',
    kind: 'other',
    permission: 'auto',
    inputSchema: { type: 'object' },
    parse: i => (typeof i === 'object' && i !== null && typeof (i as { text?: unknown }).text === 'string'
      ? (i as { text: string; delayMs?: number })
      : 'text is required'),
    subjects: async () => [{ action: 'plan' }],
    run: async i => {
      order.push(`${i.text}:start`)
      if (i.delayMs) await Bun.sleep(i.delayMs)
      order.push(`${i.text}:end`)
      ran.push(i.text)
      return { ok: true, modelText: `echo ${i.text} ${SECRET}` }
    },
  })
  const write = defineTool<{ path: string }>({
    name: 'probe.write',
    description: 'write',
    kind: 'file',
    permission: 'ask',
    inputSchema: { type: 'object' },
    parse: i => (typeof i === 'object' && i !== null && typeof (i as { path?: unknown }).path === 'string'
      ? { path: (i as { path: string }).path }
      : 'path is required'),
    subjects: async i => [{ action: 'write', path: `/ws/${i.path}`, op: 'create' }],
    run: async i => { effects.push(i.path); return { ok: true, modelText: `wrote ${i.path}`, facts: { filesTouched: [i.path] } } },
  })
  return { echo, write, ran, effects, order, tools: [echo, write] as Tool<unknown>[] }
}

const credential = { provider: 'anthropic', id: 'test' } as unknown as CredentialRef

function baseOpts(client: ProviderClient, tools: Tool<unknown>[], over: Partial<ToolLoopOptions> = {}): ToolLoopOptions {
  let inv = 0
  return {
    client,
    model: 'claude-test',
    maxTokens: 1000,
    credential,
    messages: [{ role: 'user', content: 'go' }],
    tools,
    limits: { maxTurns: 10, maxToolCalls: 10, wallTimeMs: 10_000 },
    policy: scriptedPolicy('allow'),
    content: memoryContent(),
    journal: memoryJournal(),
    runtimeVersion: 'runtime@test',
    workspaceRoot: '/ws',
    cwd: '/ws',
    scope: { runId: 'run_1', sessionId: 'ses_1' },
    mintInvocationId: () => `inv_${++inv}`,
    retry: { sleep: async () => {} },
    ...over,
  }
}

const use = (id: string, name: string, input: unknown): ProviderContent => ({ type: 'tool_use', id, name, input })
const text = (t: string): ProviderContent => ({ type: 'text', text: t })

/** Every assistant tool_use has exactly one tool_result in the NEXT message. */
function expectPaired(messages: ProviderMessage[]) {
  messages.forEach((m, i) => {
    if (m.role !== 'assistant' || typeof m.content === 'string') return
    const uses = m.content.filter((p): p is Extract<ProviderMessagePart, { type: 'tool_use' }> => p.type === 'tool_use')
    if (uses.length === 0) return
    const next = messages[i + 1]
    expect(next?.role).toBe('user')
    const results = (next!.content as ProviderMessagePart[]).filter(p => p.type === 'tool_result')
    expect(results.map(r => (r as { toolUseId: string }).toolUseId)).toEqual(uses.map(u => u.id))
  })
}

function lastResults(messages: ProviderMessage[]) {
  const last = messages[messages.length - 1]!
  return (last.content as ProviderMessagePart[]).filter(p => p.type === 'tool_result') as Array<Extract<ProviderMessagePart, { type: 'tool_result' }>>
}

// ── Tests ───────────────────────────────────────────────────────────────────────────────────────

for (const streaming of [false, true]) {
  describe(`tool loop (${streaming ? 'streaming' : 'invokeOnce'})`, () => {
    test('end-turn: no tool call ends the run after one turn', async () => {
      const client = scriptedClient([{ content: [text('done')], stop: 'end_turn' }], streaming)
      const journal = memoryJournal()
      const r = await runToolLoop(baseOpts(client, probes().tools, { journal }))
      expect(r.status).toBe('end-turn')
      expect(r.turns).toBe(1)
      expect(r.messages).toEqual([{ role: 'user', content: 'go' }, { role: 'assistant', content: [{ type: 'text', text: 'done' }] }])
      const types = journal.events.map(e => e.type)
      expect(types[0]).toBe('model.invoked')
      expect(types).toContain('model.completed')
      if (streaming) expect(types).toContain('model.started')
    })

    test('an allowed tool runs, its result goes back to the model, and the model ends', async () => {
      const p = probes()
      const client = scriptedClient([
        { content: [text('let me'), use('tu_1', 'probe__echo', { text: 'hi' })], stop: 'tool_use' },
        { content: [text('ok')], stop: 'end_turn' },
      ], streaming)
      const r = await runToolLoop(baseOpts(client, p.tools))
      expect(r.status).toBe('end-turn')
      expect(p.ran).toEqual(['hi'])
      expect(r.turns).toBe(2)
      expect(r.toolCalls).toBe(1)
      expect(r.calls).toEqual([expect.objectContaining({ toolUseId: 'tu_1', name: 'probe.echo', status: 'completed' })])
      // The provider saw wire names, and the second request carried the tool_result.
      expect(client.requests[0]!.tools!.map(t => t.name)).toEqual(['probe__echo', 'probe__write'])
      const second = client.requests[1]!.messages
      expect(second[second.length - 1]).toEqual({
        role: 'user', content: [{ type: 'tool_result', toolUseId: 'tu_1', content: `echo hi ${SECRET}`, isError: false }],
      })
      expectPaired(r.messages)
    })

    test('a DENIED tool does not run, and the model receives the refusal in words', async () => {
      const p = probes()
      const journal = memoryJournal()
      const client = scriptedClient([
        { content: [use('tu_w', 'probe__write', { path: 'a.txt' })], stop: 'tool_use' },
        { content: [text('understood')], stop: 'end_turn' },
      ], streaming)
      const r = await runToolLoop(baseOpts(client, p.tools, { policy: scriptedPolicy('deny'), journal }))
      expect(p.effects).toEqual([])
      expect(r.status).toBe('end-turn')
      expect(r.calls[0]!.status).toBe('denied')
      const sent = client.requests[1]!.messages
      expect(sent[sent.length - 1]!.content).toEqual([
        { type: 'tool_result', toolUseId: 'tu_w', content: 'Refused by the test policy.', isError: true },
      ])
      const toolTypes = journal.events.filter(e => !e.type.startsWith('model.')).map(e => e.type)
      expect(toolTypes).toEqual(['tool.requested', 'policy.requested', 'policy.denied', 'tool.denied'])
      const denied = journal.events.find(e => e.type === 'policy.denied')!
      expect(denied.data).toMatchObject({ code: 'policy.denied.test', decidedBy: 'policy' })
      expect(JSON.stringify(journal.events)).not.toContain('Refused by the test policy')
    })

    test('an unknown tool name is answered in words and nothing runs', async () => {
      const p = probes()
      const journal = memoryJournal()
      const client = scriptedClient([
        { content: [use('tu_x', 'shell__rm_rf', {})], stop: 'tool_use' },
        { content: [text('ok')], stop: 'end_turn' },
      ], streaming)
      const r = await runToolLoop(baseOpts(client, p.tools, { journal }))
      expect(r.calls[0]).toMatchObject({ status: 'unknown-tool', errorClass: 'not-found' })
      expect(r.toolCalls).toBe(0)
      const res = client.requests[1]!.messages.at(-1)!.content as ProviderMessagePart[]
      expect(res[0]).toMatchObject({ type: 'tool_result', toolUseId: 'tu_x', isError: true })
      expect((res[0] as { content: string }).content).toContain('There is no tool named "shell__rm_rf"')
      expect(p.ran).toEqual([])
      // The name the model sent is model-controlled text: it reaches the tool_result, never an event.
      expect(JSON.stringify(journal.events)).not.toContain('rm_rf')
      const req = journal.events.find(e => e.type === 'tool.requested')!
      expect(req.data).toMatchObject({ name: 'unknown-tool' })
    })

    test('bound: maxTurns — the last allowed turn runs none of its calls, and every tool_use is answered', async () => {
      const p = probes()
      const client = scriptedClient([
        { content: [use('tu_1', 'probe__echo', { text: 'one' })], stop: 'tool_use' },
        { content: [use('tu_2', 'probe__echo', { text: 'two' })], stop: 'tool_use' },
      ], streaming)
      const r = await runToolLoop(baseOpts(client, p.tools, { limits: { maxTurns: 2, maxToolCalls: 10, wallTimeMs: 10_000 } }))
      expect(r.status).toBe('max-turns')
      expect(r.sentence).toContain('2 model turns')
      expect(p.ran).toEqual(['one'])
      expect(r.calls.map(c => c.status)).toEqual(['completed', 'not-run'])
      expect(lastResults(r.messages)[0]!.content).toContain('Not run: the turn budget')
      expectPaired(r.messages)
    })

    test('bound: maxToolCalls — calls past the budget get "not run", paired, and the run stops', async () => {
      const p = probes()
      const client = scriptedClient([
        { content: [use('a', 'probe__echo', { text: 'a' }), use('b', 'probe__echo', { text: 'b' }), use('c', 'probe__echo', { text: 'c' })], stop: 'tool_use' },
      ], streaming)
      const r = await runToolLoop(baseOpts(client, p.tools, { limits: { maxTurns: 10, maxToolCalls: 2, wallTimeMs: 10_000 } }))
      expect(r.status).toBe('max-tool-calls')
      expect(p.ran).toEqual(['a', 'b'])
      expect(r.toolCalls).toBe(2)
      const results = lastResults(r.messages)
      expect(results.map(x => x.toolUseId)).toEqual(['a', 'b', 'c'])
      expect(results[2]).toMatchObject({ isError: true, content: 'Not run: the tool-call budget for this run is spent.' })
      expect(client.requests).toHaveLength(1)
      expectPaired(r.messages)
    })

    test('bound: wall time on an injected clock stops between calls', async () => {
      const clock = { t: 0 }
      const slow = defineTool<Record<string, never>>({
        name: 'probe.slow', description: 's', kind: 'other', permission: 'auto', inputSchema: { type: 'object' },
        parse: () => ({}), subjects: async () => [{ action: 'plan' }],
        run: async () => { clock.t += 1000; return { ok: true, modelText: 'slept' } },
      })
      const client = scriptedClient([
        { content: [use('s1', 'probe__slow', {}), use('s2', 'probe__slow', {})], stop: 'tool_use' },
      ], streaming)
      const r = await runToolLoop(baseOpts(client, [slow as Tool<unknown>], {
        limits: { maxTurns: 10, maxToolCalls: 10, wallTimeMs: 500 },
        monotonicNow: () => clock.t,
      }))
      expect(r.status).toBe('wall-time')
      expect(r.calls.map(c => c.status)).toEqual(['completed', 'not-run'])
      expect(lastResults(r.messages)[1]!.content).toBe('Not run: the time budget for this run is spent.')
      expectPaired(r.messages)
    })

    test('bound: a tiny wall-time budget cuts a model call that never answers', async () => {
      const client = scriptedClient([{ hang: true }], streaming)
      const r = await runToolLoop(baseOpts(client, probes().tools, { limits: { maxTurns: 10, maxToolCalls: 10, wallTimeMs: 25 } }))
      expect(r.status).toBe('wall-time')
      expect(r.messages).toEqual([{ role: 'user', content: 'go' }])
    })

    test('abort: the caller cancels mid-turn — the running call is told, the rest are not run', async () => {
      const ctl = new AbortController()
      const aborter = defineTool<Record<string, never>>({
        name: 'probe.abort', description: 'a', kind: 'other', permission: 'auto', inputSchema: { type: 'object' },
        parse: () => ({}), subjects: async () => [{ action: 'plan' }],
        run: async () => { ctl.abort(); return { ok: true, modelText: 'aborted the run' } },
      })
      const p = probes()
      const client = scriptedClient([
        { content: [use('x', 'probe__abort', {}), use('y', 'probe__echo', { text: 'never' })], stop: 'tool_use' },
      ], streaming)
      const r = await runToolLoop(baseOpts(client, [aborter as Tool<unknown>, ...p.tools], { signal: ctl.signal }))
      expect(r.status).toBe('aborted')
      expect(p.ran).toEqual([])
      expect(lastResults(r.messages)[1]!.content).toBe('Not run: the run was cancelled.')
      expectPaired(r.messages)
    })

    test('abort before start: no model call is made', async () => {
      const ctl = new AbortController()
      ctl.abort()
      const client = scriptedClient([], streaming)
      const r = await runToolLoop(baseOpts(client, probes().tools, { signal: ctl.signal }))
      expect(r.status).toBe('aborted')
      expect(r.turns).toBe(0)
      expect(client.requests).toHaveLength(0)
    })

    test('several tool_uses in one turn run SERIALLY in the order the model emitted them', async () => {
      const p = probes()
      const client = scriptedClient([
        { content: [use('1', 'probe__echo', { text: 'a', delayMs: 15 }), use('2', 'probe__echo', { text: 'b', delayMs: 1 }), use('3', 'probe__echo', { text: 'c' })], stop: 'tool_use' },
        { content: [text('ok')], stop: 'end_turn' },
      ], streaming)
      await runToolLoop(baseOpts(client, p.tools))
      expect(p.order).toEqual(['a:start', 'a:end', 'b:start', 'b:end', 'c:start', 'c:end'])
    })

    test('a failed model attempt ends the run as model-failed, journaled as model.failed', async () => {
      const journal = memoryJournal()
      const client = scriptedClient([{ fail: 'invalid-request' }], streaming)
      const r = await runToolLoop(baseOpts(client, probes().tools, { journal }))
      expect(r.status).toBe('model-failed')
      expect(r.lastResult?.status).toBe('failed')
      expect(r.sentence).toContain('the model call failed')
      expect(journal.events.map(e => e.type)).toEqual(streaming ? ['model.invoked', 'model.failed'] : ['model.invoked', 'model.failed'])
    })

    test('journal: one tool.requested and exactly one terminal per call, no content, replay converges', async () => {
      const script = (): Turn[] => [
        { content: [use('e', 'probe__echo', { text: `in-${SECRET}` }), use('w', 'probe__write', { path: 'x' }), use('u', 'nope', {})], stop: 'tool_use' },
        { content: [text('ok')], stop: 'end_turn' },
      ]
      const journal = memoryJournal()
      const policy = scriptedPolicy(req => req.call.toolName === 'probe.write'
        ? { decision: 'deny', by: 'user', policy: 'rule:no-write', code: 'policy.denied.user', sentence: `No. ${SECRET}` }
        : { decision: 'allow', by: 'auto', policy: 'default:auto' })
      const content = memoryContent()
      const r = await runToolLoop(baseOpts(scriptedClient(script(), streaming), probes().tools, { journal, policy, content }))
      expect(r.status).toBe('end-turn')

      const toolEvents = journal.events.filter(e => e.type.startsWith('tool.'))
      const byTx = new Map<string, string[]>()
      for (const e of toolEvents) {
        const tx = (e.data as { toolExecutionId: string }).toolExecutionId
        byTx.set(tx, [...(byTx.get(tx) ?? []), e.type])
      }
      expect(byTx.size).toBe(3)
      for (const types of byTx.values()) {
        expect(types.filter(t => t === 'tool.requested')).toHaveLength(1)
        expect(types.filter(t => t === 'tool.completed' || t === 'tool.failed' || t === 'tool.denied')).toHaveLength(1)
      }
      for (const e of journal.events) {
        expect(e.provenance.mode).toBe('native')
      }
      // The result text is referenced by hash, never inlined.
      const completed = journal.events.find(e => e.type === 'tool.completed')!
      const ref = (completed.data as { result?: { sha256: string } }).result!
      expect(content.store.get(ref.sha256)).toBe(`echo in-${SECRET} ${SECRET}`)
      expect(JSON.stringify(journal.events)).not.toContain(SECRET)
      expect(JSON.stringify(journal.events)).not.toContain('in-')

      // Replay the same run into the same journal: every event is a duplicate.
      msgCounter -= 2
      const before = journal.events.length
      await runToolLoop(baseOpts(scriptedClient(script(), streaming), probes().tools, { journal, policy, content: memoryContent() }))
      expect(journal.events.length).toBe(before)
      expect(journal.duplicates).toBe(before)
    })

    test('no journal at all: the run completes and the loss is counted', async () => {
      const p = probes()
      const client = scriptedClient([
        { content: [use('1', 'probe__echo', { text: 'a' })], stop: 'tool_use' },
        { content: [text('ok')], stop: 'end_turn' },
      ], streaming)
      const r = await runToolLoop(baseOpts(client, p.tools, { journal: null }))
      expect(r.status).toBe('end-turn')
      expect(r.lost.tool['tool.requested']).toBe(1)
      expect(r.lost.tool['tool.completed']).toBe(1)
      expect(r.lost.provider['model.invoked']).toBe(2)
    })
  })
}

describe('tool loop — streamed calls that could not be assembled', () => {
  test('a malformed streamed call is never executed; the model is told in words; the valid one runs', async () => {
    const p = probes()
    const journal = memoryJournal()
    const failure: ToolCallFailure = { index: 0, id: 'bad', name: 'probe__write', reason: 'malformed', userCode: 'provider.tool_call_malformed' }
    const client = scriptedClient([
      {
        content: [{ type: 'other', rawType: 'tool_use' }, use('good', 'probe__echo', { text: 'ok' })],
        stop: 'tool_use',
        failures: [failure],
      },
      { content: [text('fine')], stop: 'end_turn' },
    ], true)
    const r = await runToolLoop(baseOpts(client, p.tools, { journal }))
    expect(r.status).toBe('end-turn')
    expect(p.effects).toEqual([])
    expect(p.ran).toEqual(['ok'])
    expect(r.calls.map(c => c.status)).toEqual(['malformed', 'completed'])
    const assistant = r.messages[1]!.content as ProviderMessagePart[]
    expect(assistant[0]).toEqual({ type: 'tool_use', id: 'bad', name: 'probe__write', input: {} })
    const results = r.messages[2]!.content as Array<Extract<ProviderMessagePart, { type: 'tool_result' }>>
    expect(results[0]).toMatchObject({ toolUseId: 'bad', isError: true })
    expect(results[0]!.content).toContain('could not be read as JSON')
    expectPaired(r.messages)
    // Journaled as a failed call with a class, never as a policy decision.
    const badTx = r.calls[0]!.toolExecutionId
    const types = journal.events.filter(e => (e.data as { toolExecutionId?: string }).toolExecutionId === badTx).map(e => e.type)
    expect(types).toEqual(['tool.requested', 'tool.failed'])
  })

  test('a client that cannot stream is driven through invokeOnce', async () => {
    const client = scriptedClient([{ content: [text('x')], stop: 'end_turn' }], false)
    let streamed = 0
    const r = await runToolLoop(baseOpts(client, probes().tools, { onStreamEvent: () => { streamed += 1 } }))
    expect(r.status).toBe('end-turn')
    expect(streamed).toBe(0)
  })
})

describe('wire names', () => {
  test('dots become double underscores and the provider pattern holds', () => {
    expect(toWireName('file.read')).toBe('file__read')
    expect(toWireName('git.status')).toBe('git__status')
  })

  test('a colliding or duplicate catalogue is refused before any model call', async () => {
    const mk = (name: string) => defineTool({
      name, description: '', kind: 'other', permission: 'auto', inputSchema: {},
      parse: () => ({}), subjects: async () => [], run: async () => ({ ok: true, modelText: '' }),
    }) as Tool<unknown>
    const clash = buildWireTable([mk('a.b'), mk('a__b')])
    expect(clash.ok).toBe(false)
    expect(buildWireTable([mk('a.b'), mk('a.b')]).ok).toBe(false)
    expect(buildWireTable([mk('x'.repeat(65))]).ok).toBe(false)

    const client = scriptedClient([], false)
    const r = await runToolLoop(baseOpts(client, [mk('a.b'), mk('a__b')]))
    expect(r.status).toBe('invalid-catalogue')
    expect(r.sentence).toContain('same name "a__b"')
    expect(client.requests).toHaveLength(0)
  })
})

// ── H18: the doom-loop guard ────────────────────────────────────────────────────────────────────

describe('repeat guard (H18)', () => {
  const same = (n: number, input: unknown = { text: 'loop' }): Turn[] => [
    ...Array.from({ length: n }, (_, i) => ({ content: [use(`tu_${i + 1}`, 'probe__echo', input)], stop: 'tool_use' as const })),
    { content: [text('giving up')], stop: 'end_turn' as const },
  ]

  for (const streaming of [false, true]) {
    test(`${streaming ? 'streaming' : 'invokeOnce'}: the 3rd identical call asks; denied → not run, the model is told in words`, async () => {
      const p = probes()
      const journal = memoryJournal()
      const asker = scriptedAsker([{ answered: true, choice: 1 }])
      const client = scriptedClient(same(3), streaming)
      const r = await runToolLoop(baseOpts(client, p.tools, { journal, asker }))
      expect(r.status).toBe('end-turn')
      expect(p.ran).toEqual(['loop', 'loop'])
      expect(asker.asked).toHaveLength(1)
      expect(asker.asked[0]!.kind).toBe('permission')
      expect(asker.asked[0]!.text).toContain('the same `probe.echo` with the same input 3 times in a row')
      expect(r.calls.map(c => c.status)).toEqual(['completed', 'completed', 'denied'])
      const third = lastResults(client.requests[3]!.messages)[0]!
      expect(third.isError).toBe(true)
      expect(third.content).toContain('Not run: you asked to run the same `probe.echo` with the same input 3 times in a row')
      expect(third.content).toContain('A person declined')
      const denied = journal.events.filter(e => e.type === 'policy.denied')
      expect(denied).toHaveLength(1)
      expect(denied[0]!.data).toMatchObject({ policy: 'repeat-guard', code: 'policy.denied.repeat-guard', decidedBy: 'user' })
      expectPaired(r.messages)
    })
  }

  test('with no person present the repeat is refused in words, and every further repeat too', async () => {
    const p = probes()
    const client = scriptedClient(same(5), false)
    const r = await runToolLoop(baseOpts(client, p.tools))
    expect(p.ran).toEqual(['loop', 'loop'])
    expect(r.calls.map(c => c.status)).toEqual(['completed', 'completed', 'denied', 'denied', 'denied'])
    const refusal = lastResults(client.requests[3]!.messages)[0]!.content
    expect(refusal).toContain('no person was available')
  })

  test('allowed → it runs, and the count restarts from that call', async () => {
    const p = probes()
    const asker = scriptedAsker([{ answered: true, choice: 0 }, { answered: true, choice: 0 }])
    const client = scriptedClient(same(5), false)
    const r = await runToolLoop(baseOpts(client, p.tools, { asker }))
    // calls 1,2 silent; 3 asked + allowed; 4 silent (count 2); 5 asked again.
    expect(p.ran).toHaveLength(5)
    expect(asker.asked).toHaveLength(2)
    expect(r.calls.map(c => c.status)).toEqual(['completed', 'completed', 'completed', 'completed', 'completed'])
  })

  test('a deny from the run\'s policy is never turned into a question', async () => {
    const p = probes()
    const asker = scriptedAsker([])
    const client = scriptedClient(same(4), false)
    const r = await runToolLoop(baseOpts(client, p.tools, { asker, policy: scriptedPolicy('deny') }))
    expect(asker.asked).toHaveLength(0)
    expect(r.calls.every(c => c.status === 'denied')).toBe(true)
    expect(lastResults(client.requests[4]!.messages)[0]!.content).toBe('Refused by the test policy.')
  })

  test('a call whose result keeps changing is polling, not a loop — nobody is asked', async () => {
    let n = 0
    const tick = defineTool<Record<string, never>>({
      name: 'probe.tick', description: 'tick', kind: 'other', permission: 'auto', inputSchema: { type: 'object' },
      parse: () => ({}), subjects: async () => [{ action: 'plan' }],
      run: async () => ({ ok: true, modelText: `tick ${++n}` }),
    }) as Tool<unknown>
    const asker = scriptedAsker([])
    const turns: Turn[] = [
      ...Array.from({ length: 5 }, (_, i) => ({ content: [use(`tu_${i}`, 'probe__tick', {})], stop: 'tool_use' as const })),
      { content: [text('done')], stop: 'end_turn' },
    ]
    const r = await runToolLoop(baseOpts(scriptedClient(turns, false), [tick], { asker }))
    expect(n).toBe(5)
    expect(asker.asked).toHaveLength(0)
    expect(r.status).toBe('end-turn')
  })

  test('reordered keys are the same call; a different input in between resets', async () => {
    const p = probes()
    const asker = scriptedAsker([])
    const turns: Turn[] = [
      { content: [use('a', 'probe__echo', { text: 'x', delayMs: 0 })], stop: 'tool_use' },
      { content: [use('b', 'probe__echo', { delayMs: 0, text: 'x' })], stop: 'tool_use' },
      { content: [use('c', 'probe__echo', { text: 'y' })], stop: 'tool_use' },
      { content: [use('d', 'probe__echo', { text: 'x', delayMs: 0 })], stop: 'tool_use' },
      { content: [use('e', 'probe__echo', { delayMs: 0, text: 'x' })], stop: 'tool_use' },
      { content: [use('f', 'probe__echo', { text: 'x', delayMs: 0 })], stop: 'tool_use' },
      { content: [text('done')], stop: 'end_turn' },
    ]
    const r = await runToolLoop(baseOpts(scriptedClient(turns, false), p.tools, { asker }))
    expect(p.ran).toEqual(['x', 'x', 'y', 'x', 'x'])
    expect(asker.asked).toHaveLength(1)
    expect(r.calls[5]!.status).toBe('denied')
  })

  test('when the policy itself asked about the call, the person is not asked twice', async () => {
    const p = probes()
    const asker = scriptedAsker([{ answered: true, choice: 0 }])
    let calls = 0
    const policy = {
      async evaluate(req: Parameters<ReturnType<typeof scriptedPolicy>['evaluate']>[0]) {
        calls += 1
        if (calls < 3) return { decision: 'allow' as const, by: 'policy' as const, policy: 'test:allow' }
        await req.asker!.ask({ id: 'q', kind: 'permission', text: 'ok?', options: [{ label: 'Allow once' }] })
        return { decision: 'allow' as const, by: 'user' as const, policy: 'test:ask' }
      },
    }
    const r = await runToolLoop(baseOpts(scriptedClient(same(3), false), p.tools, { asker, policy }))
    expect(asker.asked).toHaveLength(1)
    expect(p.ran).toHaveLength(3)
    expect(r.calls[2]!.status).toBe('completed')
  })
})
