/**
 * completion-gate.test.ts — the completion gate (TOOL.3) folded into the tool loop, OFFLINE: a
 * scripted non-streaming client, the real `task.plan` tool, probe tools named like the catalogue's
 * edit / shell tools, and an in-memory journal. Covers spec §6.3's six acceptance criteria at the
 * loop level (the pure rules are in `completion/gate.test.ts`).
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
  ProviderMessagePart,
  ProviderRequest,
} from '../provider/client.ts'
import type { ProviderJournalSink } from '../provider/emit.ts'
import type { PersonAsker, Tool } from '../tools/contract.ts'
import { defineTool } from '../tools/define.ts'
import { createPlanTool, type PlanStep } from '../tools/interact/plan.ts'
import { memoryContent, scriptedPolicy } from '../tools/testing.ts'
import { runToolLoop, type ToolLoopOptions } from './loop.ts'

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

function scriptedClient(turns: Turn[]): ProviderClient & { requests: ProviderRequest[] } {
  const requests: ProviderRequest[] = []
  let n = 0
  return {
    requests,
    provider: 'anthropic',
    adapterVersion: 'stub@1',
    capabilities: { streaming: false, editPolicy: 'verbatim' as never },
    async invokeOnce(req, attempt): Promise<InvocationResult> {
      requests.push(structuredClone({ ...req, signal: undefined }))
      const t = turns.shift()
      if (!t) throw new Error('script exhausted')
      n += 1
      return {
        invocationId: req.correlation.invocationId, attempt, provider: 'anthropic',
        requestedModel: req.model, startedAt: '2026-09-29T12:00:00.000Z', latencyMs: 5,
        status: 'completed', messageId: `msg_${n}`, servedModel: req.model,
        usage: fromAnthropicUsage({ input_tokens: 10, output_tokens: 5 }).usage, usageAnomalies: [],
        stopReason: fromAnthropicStopReason(t.stop), content: t.content,
      }
    },
  }
}

const use = (id: string, name: string, input: unknown): ProviderContent => ({ type: 'tool_use', id, name, input })
const text = (t: string): ProviderContent => ({ type: 'text', text: t })
const end = (t = 'done'): Turn => ({ content: [text(t)], stop: 'end_turn' })
const planCall = (id: string, steps: PlanStep[]): Turn => ({ content: [use(id, 'task__plan', { steps })], stop: 'tool_use' })

function probeTools() {
  const echo = defineTool<{ text: string }>({
    name: 'probe.echo', description: 'echo', kind: 'other', permission: 'auto', inputSchema: { type: 'object' },
    parse: i => ({ text: String((i as { text?: unknown }).text ?? '') }),
    subjects: async () => [{ action: 'plan' }],
    run: async () => ({ ok: true, modelText: 'echoed' }),
  })
  const write = defineTool<{ path: string }>({
    name: 'file.write', description: 'write', kind: 'file', permission: 'auto', inputSchema: { type: 'object' },
    parse: i => ({ path: String((i as { path?: unknown }).path ?? '') }),
    subjects: async () => [{ action: 'plan' }],
    run: async i => ({ ok: true, modelText: `wrote ${i.path}`, facts: { filesTouched: [i.path] } }),
  })
  const shell = defineTool<{ code: number }>({
    name: 'shell.start', description: 'shell', kind: 'shell', permission: 'auto', inputSchema: { type: 'object' },
    parse: i => ({ code: Number((i as { code?: unknown }).code ?? 0) }),
    subjects: async () => [{ action: 'plan' }],
    run: async i => ({ ok: i.code === 0, modelText: `[exit code ${i.code}]`, facts: { exitCode: i.code },
      ...(i.code === 0 ? {} : { error: { class: 'nonzero-exit' as never, detail: 'exit' } }) }),
  })
  return [echo, write, shell] as Tool<unknown>[]
}

const credential = { provider: 'anthropic', id: 'test' } as unknown as CredentialRef

function setup(turns: Turn[], over: Partial<ToolLoopOptions> = {}, gate: Partial<NonNullable<ToolLoopOptions['completion']>> = {}) {
  const plan = createPlanTool()
  const client = scriptedClient(turns)
  const journal = memoryJournal()
  let inv = 0
  const opts: ToolLoopOptions = {
    client, model: 'claude-test', maxTokens: 1000, credential,
    messages: [{ role: 'user', content: 'go' }],
    tools: [plan.tool as Tool<unknown>, ...probeTools()],
    limits: { maxTurns: 20, maxToolCalls: 20, wallTimeMs: 10_000 },
    policy: scriptedPolicy('allow'), content: memoryContent(), journal,
    runtimeVersion: 'runtime@test', workspaceRoot: '/ws', cwd: '/ws',
    scope: { runId: 'run_1', sessionId: 'ses_1' },
    mintInvocationId: () => `inv_${++inv}`,
    retry: { sleep: async () => {} },
    completion: { plan: plan.plan, ...gate },
    ...over,
  }
  return { plan, client, journal, opts }
}

const completionEvents = (j: { events: AgentisticsEvent[] }) =>
  j.events.filter(e => e.type.startsWith('completion.')).map(e => ({ type: e.type, data: e.data }))

const OPEN: PlanStep[] = [
  { text: 'step A', status: 'completed' },
  { text: 'step B', status: 'in_progress' },
  { text: 'step C', status: 'pending' },
]

describe('completion gate in the loop', () => {
  test('#1 open items: continuation + completion.blocked; with K spent, released forced-limit', async () => {
    const s = setup([planCall('tu_1', OPEN), end('a'), end('b'), end('c')])
    const r = await runToolLoop(s.opts)
    expect(r.status).toBe('end-turn')
    expect(r.turns).toBe(4)
    expect(r.completion).toMatchObject({ blocked: 2, released: 'forced-limit' })
    expect(r.completion?.sentence).toContain('2 plan items still open')
    expect(completionEvents(s.journal)).toEqual([
      { type: 'completion.blocked', data: { openItems: 2, attempt: 1, rule: 'open-plan' } },
      { type: 'completion.blocked', data: { openItems: 2, attempt: 2, rule: 'open-plan' } },
      { type: 'completion.released', data: { reason: 'forced-limit', openItems: 2 } },
    ])
    // The continuation is a user message stating the facts, right after the model's answer.
    const injected = r.messages[4]!
    expect(injected.role).toBe('user')
    const t = (injected.content as ProviderMessagePart[])[0] as { type: 'text'; text: string }
    expect(t.text).toContain('Completion check (1 of 2): 2 plan items are still open')
    expect(t.text).toContain('[~] step B')
  })

  test('the model closing its plan after a block releases satisfied', async () => {
    const done = OPEN.map(x => ({ ...x, status: 'completed' as const }))
    const s = setup([planCall('tu_1', OPEN), end('a'), planCall('tu_2', done), end('b')])
    const r = await runToolLoop(s.opts)
    expect(r.completion).toMatchObject({ blocked: 1, released: 'satisfied' })
    expect(completionEvents(s.journal).map(e => e.type)).toEqual(['completion.blocked', 'completion.released'])
  })

  test('#2 unchanged open set and no distinct tool result over N turns: released no-progress', async () => {
    // Distinct inputs (so the H18 repeat guard stays out of it), one identical result every time.
    const echo = (id: string): Turn => ({ content: [use(id, 'probe__echo', { text: id })], stop: 'tool_use' })
    const s = setup([planCall('tu_1', OPEN), echo('tu_2'), echo('tu_3'), echo('tu_4'), end()])
    const r = await runToolLoop(s.opts)
    expect(r.status).toBe('end-turn')
    expect(r.completion).toMatchObject({ blocked: 0, released: 'no-progress' })
    expect(completionEvents(s.journal)).toEqual([
      { type: 'completion.released', data: { reason: 'no-progress', openItems: 2 } },
    ])
  })

  test('#3 no plan, no gate: a run with no task.plan items ends on its first end-turn and emits nothing', async () => {
    const s = setup([end()])
    const r = await runToolLoop(s.opts)
    expect(r.turns).toBe(1)
    expect(r.completion).toEqual({ blocked: 0, released: null, lost: { 'completion.blocked': 0, 'completion.released': 0 } })
    expect(completionEvents(s.journal)).toEqual([])
  })

  test('without completion options the loop is unchanged (no result field, no event)', async () => {
    const s = setup([planCall('tu_1', OPEN), end()], { completion: undefined })
    const r = await runToolLoop(s.opts)
    expect(r.turns).toBe(2)
    expect(r.completion).toBeUndefined()
    expect(completionEvents(s.journal)).toEqual([])
  })

  test('#4 Rule 3 is inert unless the setting is on; on, an edit with no later passing command blocks once', async () => {
    const edit: Turn = { content: [use('tu_1', 'file__write', { path: 'a.ts' })], stop: 'tool_use' }
    const off = setup([edit, end()])
    expect((await runToolLoop(off.opts)).turns).toBe(2)

    const on = setup([structuredClone(edit), end('a'), end('b')], {}, { requireVerificationAfterEdit: true })
    const r = await runToolLoop(on.opts)
    expect(r.turns).toBe(3)
    expect(r.completion).toMatchObject({ blocked: 1, released: 'forced-limit' })
    expect(completionEvents(on.journal)[0]).toEqual({ type: 'completion.blocked', data: { openItems: 0, attempt: 1, rule: 'verify-after-edit' } })

    const verified = setup([
      structuredClone(edit),
      { content: [use('tu_2', 'shell__start', { code: 0 })], stop: 'tool_use' },
      end(),
    ], {}, { requireVerificationAfterEdit: true })
    const rv = await runToolLoop(verified.opts)
    expect(rv.turns).toBe(3)
    expect(rv.completion).toMatchObject({ blocked: 0, released: null })
  })

  test('#5 headless: no asker, and an asker that would throw is never called — same outcome', async () => {
    const script = () => [planCall('tu_1', OPEN), end('a'), end('b'), end('c')]
    const headless = await runToolLoop(setup(script()).opts)
    let asked = 0
    const asker = { ask: async () => { asked += 1; throw new Error('must not ask') } } as unknown as PersonAsker
    const attended = await runToolLoop(setup(script(), { asker }).opts)
    expect(asked).toBe(0)
    expect(attended.messages).toEqual(headless.messages)
    expect(attended.completion).toEqual(headless.completion)
  })

  test('#6 the gate adds no tool call and never touches the plan: only the injected message differs', async () => {
    const s = setup([planCall('tu_1', OPEN), end('a'), end('b'), end('c')])
    const r = await runToolLoop(s.opts)
    expect(r.calls.map(c => c.name)).toEqual(['task.plan'])
    expect(r.toolCalls).toBe(1)
    expect(s.plan.plan()).toEqual(OPEN)
    const injected = r.messages.filter(m => m.role === 'user' && Array.isArray(m.content) &&
      m.content.some(p => p.type === 'text' && p.text.startsWith('Completion check')))
    expect(injected).toHaveLength(2)
    for (const m of injected) expect((m.content as ProviderMessagePart[]).every(p => p.type === 'text')).toBe(true)
  })

  test('no turn left: the gate releases run-budget instead of turning the answer into max-turns', async () => {
    const s = setup([planCall('tu_1', OPEN), end()], { limits: { maxTurns: 2, maxToolCalls: 20, wallTimeMs: 10_000 } })
    const r = await runToolLoop(s.opts)
    expect(r.status).toBe('end-turn')
    expect(r.completion).toMatchObject({ blocked: 0, released: 'run-budget' })
  })

  test('an empty final assistant turn: the fact joins the last user message, roles still alternate', async () => {
    const s = setup([planCall('tu_1', OPEN), { content: [], stop: 'end_turn' }, end()], {}, { maxContinuations: 1 })
    const r = await runToolLoop(s.opts)
    for (let i = 1; i < r.messages.length; i++) expect(r.messages[i]!.role).not.toBe(r.messages[i - 1]!.role)
    const last = r.messages[2]!.content as ProviderMessagePart[]
    expect(last.map(p => p.type)).toEqual(['tool_result', 'text'])
  })

  test('events carry counts only — never a plan step text', async () => {
    const s = setup([planCall('tu_1', OPEN), end('a'), end('b'), end('c')])
    await runToolLoop(s.opts)
    const blob = JSON.stringify(s.journal.events.filter(e => e.type.startsWith('completion.')))
    expect(blob).not.toContain('step B')
  })
})
