/**
 * structured.test.ts — TOOL.1 through the real loop, fully OFFLINE: a scripted provider submits
 * values through `result.submit`, an in-memory journal receives every event, and the assertions are
 * the spec's acceptance criteria (§6.1): k attempts ↔ k billed responses, exhaustion yields `null`,
 * a refused request makes ZERO provider calls.
 */
import { describe, expect, test } from 'bun:test'
import {
  fromAnthropicStopReason,
  fromAnthropicUsage,
  type AgentisticsEvent,
} from '@agentistics/core'
import type {
  CredentialRef,
  InvocationResult,
  ProviderClient,
  ProviderContent,
  ProviderRequest,
  ProviderStreamEvent,
} from '../provider/client.ts'
import type { ProviderJournalSink } from '../provider/emit.ts'
import type { Tool } from '../tools/contract.ts'
import { defineTool } from '../tools/define.ts'
import { memoryContent, scriptedPolicy } from '../tools/testing.ts'
import { runToolLoop, type ToolLoopOptions } from './loop.ts'
import { toWireName } from './wire.ts'

const SUBMIT = toWireName('result.submit')
const SECRET = 'SECRET-VALUE-91b2'

function memoryJournal(): ProviderJournalSink & { events: AgentisticsEvent[] } {
  const events: AgentisticsEvent[] = []
  const seen = new Set<string>()
  return {
    events,
    async append(batch: readonly AgentisticsEvent[]) {
      let written = 0
      let duplicates = 0
      for (const e of batch) {
        if (seen.has(e.eventId)) { duplicates += 1; continue }
        seen.add(e.eventId); events.push(e); written += 1
      }
      return { written, duplicates }
    },
  }
}

type Turn = { content: ProviderContent[]; stop: 'end_turn' | 'tool_use' }

function scriptedClient(turns: Turn[], streaming: boolean): ProviderClient & { requests: ProviderRequest[] } {
  const requests: ProviderRequest[] = []
  let n = 0
  const answer = async (req: ProviderRequest, attempt: number): Promise<InvocationResult> => {
    const t = turns.shift()
    if (!t) throw new Error('script exhausted')
    n += 1
    return {
      invocationId: req.correlation.invocationId, attempt, provider: 'anthropic',
      requestedModel: req.model, startedAt: '2026-09-29T12:00:00.000Z', latencyMs: 5,
      status: 'completed', messageId: `msg_${n}`, servedModel: req.model,
      usage: fromAnthropicUsage({ input_tokens: 10, output_tokens: 5 }).usage, usageAnomalies: [],
      stopReason: fromAnthropicStopReason(t.stop), content: t.content,
      ...(streaming ? { toolCallFailures: [] } : {}),
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
      }
      yield { type: 'end', result: r }
    }
  }
  return client
}

const credential = { provider: 'anthropic', id: 'test' } as unknown as CredentialRef

const SCHEMA = {
  type: 'object',
  properties: { verdict: { type: 'string', enum: ['pass', 'fail'] }, score: { type: 'integer' } },
  required: ['verdict', 'score'],
  additionalProperties: false,
}

function opts(client: ProviderClient, over: Partial<ToolLoopOptions> = {}): ToolLoopOptions & { journal: ReturnType<typeof memoryJournal> } {
  let inv = 0
  return {
    client, model: 'claude-test', maxTokens: 1000, credential,
    messages: [{ role: 'user', content: 'review it' }],
    tools: [],
    limits: { maxTurns: 10, maxToolCalls: 10, wallTimeMs: 10_000 },
    policy: scriptedPolicy('allow'),
    content: memoryContent(),
    journal: memoryJournal(),
    runtimeVersion: 'runtime@test',
    workspaceRoot: '/ws', cwd: '/ws',
    scope: { runId: 'run_1', sessionId: 'ses_1' },
    mintInvocationId: () => `inv_${++inv}`,
    retry: { sleep: async () => {} },
    structured: { schema: SCHEMA },
    ...over,
  } as ToolLoopOptions & { journal: ReturnType<typeof memoryJournal> }
}

const submit = (id: string, value: unknown): ProviderContent => ({ type: 'tool_use', id, name: SUBMIT, input: { value } })
const turn = (...content: ProviderContent[]): Turn => ({ content, stop: content.some(c => c.type === 'tool_use') ? 'tool_use' : 'end_turn' })
const ofType = (j: { events: AgentisticsEvent[] }, t: string) => j.events.filter(e => e.type === t)

for (const streaming of [false, true]) {
  describe(`structured output (${streaming ? 'streaming' : 'non-streaming'})`, () => {
    test('valid on attempt k: k attempts, each tied to one of k billed responses', async () => {
      const client = scriptedClient([
        turn(submit('t1', { verdict: 'maybe', score: 1 })),
        turn(submit('t2', { verdict: 'pass', score: 1.5, extra: SECRET })),
        turn(submit('t3', { verdict: 'pass', score: 7 })),
      ], streaming)
      const o = opts(client)
      const r = await runToolLoop(o)

      expect(r.status).toBe('submitted')
      expect(r.structured).toMatchObject({ value: { verdict: 'pass', score: 7 }, attempts: 3, maxRetries: 2 })
      expect(r.structured?.reason).toBeUndefined()

      const attempts = ofType(o.journal, 'structured.attempt')
      const billed = ofType(o.journal, 'model.completed')
      expect(attempts.length).toBe(3)
      expect(billed.length).toBe(3)
      expect(attempts.map(e => (e.data as { attempt: number }).attempt)).toEqual([1, 2, 3])
      expect(attempts.map(e => (e.data as { ok: boolean }).ok)).toEqual([false, false, true])
      expect(attempts.map(e => (e.data as { errorCount: number }).errorCount)).toEqual([1, 2, 0])
      // The tie is an id, not an order: each attempt names the billed response it came in.
      const billedIds = billed.map(e => (e.data as { attemptId?: string }).attemptId)
      expect(attempts.map(e => (e.data as { invocationId: string }).invocationId)).toEqual(billedIds as string[])
      // Each billed response carries its usage (the cost basis the projection prices).
      for (const b of billed) expect((b.data as { usage: unknown }).usage).toBeDefined()
      expect(ofType(o.journal, 'structured.exhausted').length).toBe(0)
      // Counts only: neither the value nor a validation message reaches the journal.
      expect(JSON.stringify(o.journal.events)).not.toContain(SECRET)
      expect(JSON.stringify(o.journal.events)).not.toContain('maybe')
    })

    test('the model reads every validation problem, then retries', async () => {
      const client = scriptedClient([
        turn(submit('t1', { verdict: 'maybe' })),
        turn(submit('t2', { verdict: 'fail', score: 0 })),
      ], streaming)
      const r = await runToolLoop(opts(client))
      expect(r.status).toBe('submitted')
      const second = client.requests[1]!
      const last = second.messages.at(-1)!
      const txt = JSON.stringify(last.content)
      expect(txt).toContain('$.verdict')
      expect(txt).toContain('$.score')
      expect(txt).toContain('call result.submit again')
    })

    test('exhaustion returns null with schema-failed — never the last near-miss', async () => {
      const client = scriptedClient([
        turn(submit('t1', { verdict: 'pass' })),
        turn(submit('t2', { verdict: 'pass', score: 'x' })),
        turn(submit('t3', { verdict: 'pass', score: 1, extra: 1 })),
        turn(submit('t4', { verdict: 'pass', score: 1 })), // never reached
      ], streaming)
      const o = opts(client)
      const r = await runToolLoop(o)
      expect(r.status).toBe('schema-failed')
      expect(r.structured).toMatchObject({ value: null, reason: 'schema-failed', attempts: 3 })
      expect(client.requests.length).toBe(3)
      expect(ofType(o.journal, 'structured.attempt').length).toBe(3)
      const ex = ofType(o.journal, 'structured.exhausted')
      expect(ex.length).toBe(1)
      expect(ex[0]!.data).toEqual({ attempts: 3 })
    })

    test('maxRetries: 0 means one attempt', async () => {
      const client = scriptedClient([turn(submit('t1', { verdict: 'pass' }))], streaming)
      const r = await runToolLoop(opts(client, { structured: { schema: SCHEMA, maxRetries: 0 } }))
      expect(r.status).toBe('schema-failed')
      expect(r.structured?.attempts).toBe(1)
    })

    test('a turn that ends without submitting is an attempt, and the model is told to submit', async () => {
      const client = scriptedClient([
        turn({ type: 'text', text: 'Here is my verdict: pass.' }),
        turn(submit('t2', { verdict: 'pass', score: 3 })),
      ], streaming)
      const o = opts(client)
      const r = await runToolLoop(o)
      expect(r.status).toBe('submitted')
      const a = ofType(o.journal, 'structured.attempt').map(e => e.data)
      expect(a).toEqual([
        { attempt: 1, ok: false, errorCount: 1, submitted: false, invocationId: 'inv_1' },
        { attempt: 2, ok: true, errorCount: 0, submitted: true, invocationId: 'inv_2' },
      ])
      expect(JSON.stringify(client.requests[1]!.messages.at(-1))).toContain('result.submit')
      // Roles still alternate after the nudge.
      const roles = client.requests[1]!.messages.map(m => m.role)
      for (let i = 1; i < roles.length; i++) expect(roles[i]).not.toBe(roles[i - 1])
    })

    test('calls after an accepted submission in the same turn are not run, in words', async () => {
      const ran: string[] = []
      const probe = defineTool<{ x: string }>({
        name: 'probe.echo', description: 'echo', kind: 'other', permission: 'auto', inputSchema: { type: 'object' },
        parse: i => ({ x: String((i as { x?: unknown }).x) }),
        subjects: async () => [{ action: 'plan' }],
        run: async i => { ran.push(i.x); return { ok: true, modelText: 'ok' } },
      })
      const client = scriptedClient([
        turn(
          { type: 'tool_use', id: 'a', name: toWireName('probe.echo'), input: { x: 'before' } },
          submit('b', { verdict: 'pass', score: 1 }),
          { type: 'tool_use', id: 'c', name: toWireName('probe.echo'), input: { x: 'after' } },
        ),
      ], streaming)
      const r = await runToolLoop(opts(client, { tools: [probe as Tool<unknown>] }))
      expect(r.status).toBe('submitted')
      expect(ran).toEqual(['before'])
      expect(r.calls.map(c => c.status)).toEqual(['completed', 'completed', 'not-run'])
      const results = JSON.stringify(r.messages.at(-1))
      expect(results).toContain('a result was already accepted')
    })

    test('a submission in the last turn maxTurns allows still counts', async () => {
      const client = scriptedClient([
        turn(submit('t1', { verdict: 'x' })),
        turn(submit('t2', { verdict: 'pass', score: 2 })),
      ], streaming)
      const r = await runToolLoop(opts(client, { limits: { maxTurns: 2, maxToolCalls: 10, wallTimeMs: 10_000 } }))
      expect(r.status).toBe('submitted')
      expect(r.structured?.value).toEqual({ verdict: 'pass', score: 2 })
    })

    test('a run stopped by another bound says so and holds no value', async () => {
      const client = scriptedClient([turn(submit('t1', { verdict: 'x' })), turn(submit('t2', { verdict: 'y' }))], streaming)
      const r = await runToolLoop(opts(client, { limits: { maxTurns: 5, maxToolCalls: 1, wallTimeMs: 10_000 }, structured: { schema: SCHEMA, maxRetries: 5 } }))
      expect(r.status).toBe('max-tool-calls')
      expect(r.structured).toMatchObject({ value: null, reason: 'run-stopped', attempts: 1 })
    })
  })
}

describe('structured output — refused before any provider call', () => {
  const cases: Array<[string, unknown, number | undefined, string]> = [
    ['an unsatisfiable schema', { type: 'object', properties: {}, required: ['a'], additionalProperties: false }, undefined, 'unsatisfiable'],
    ['an empty enum', { enum: [] }, undefined, 'unsatisfiable'],
    ['a keyword outside the subset', { type: 'string', pattern: '^x' }, undefined, 'unsupported'],
    ['maxRetries above 5', SCHEMA, 6, 'max-retries'],
  ]
  for (const [name, schema, maxRetries, code] of cases) {
    test(`${name}: zero provider calls, status structured-refused`, async () => {
      const client = scriptedClient([turn(submit('t1', { verdict: 'pass', score: 1 }))], false)
      const o = opts(client, { structured: maxRetries === undefined ? { schema } : { schema, maxRetries } })
      const r = await runToolLoop(o)
      expect(client.requests.length).toBe(0)
      expect(r.status).toBe('structured-refused')
      expect(r.turns).toBe(0)
      expect(r.structured).toMatchObject({ value: null, reason: 'refused', attempts: 0, refusal: { code } })
      expect(r.sentence).toContain('no model call was made')
      expect(o.journal.events.length).toBe(0)
    })
  }
})

describe('structured output — absent means the loop is unchanged', () => {
  test('no result.submit is declared and no structured field is returned', async () => {
    const client = scriptedClient([turn({ type: 'text', text: 'done' })], false)
    const r = await runToolLoop(opts(client, { structured: undefined }))
    expect(r.status).toBe('end-turn')
    expect(r.structured).toBeUndefined()
    expect(client.requests[0]!.tools?.some(t => t.name === SUBMIT) ?? false).toBe(false)
  })
  test('with it, result.submit is declared with the schema as its value', async () => {
    const client = scriptedClient([turn(submit('t1', { verdict: 'pass', score: 1 }))], false)
    await runToolLoop(opts(client))
    const decl = client.requests[0]!.tools!.find(t => t.name === SUBMIT)!
    expect(JSON.stringify(decl)).toContain('"enum":["pass","fail"]')
  })
})
