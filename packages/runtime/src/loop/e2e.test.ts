/**
 * e2e.test.ts — M1, offline: the REAL loop, the REAL policy and the REAL v1 catalogue acting on a
 * throwaway git repository, driven by a scripted model. Nothing here is a double except the model
 * (a script) and the person (a scripted asker) — which is exactly the owner's line: a live run
 * through OpenRouter or Anthropic is the owner's, not a test's.
 *
 * What it proves, in one conversation: a read, a patch a person approved, a shell command a person
 * approved that sees the patched file, a dangerous command refused by the floor WITHOUT asking
 * anyone, a git read that needs no approval, a read outside the workspace refused in words — and
 * that every call left one `tool.requested` and exactly one terminal event in the journal.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
import { createPolicy } from '../policy/index.ts'
import { createNativeTools, type NativeTools } from '../tools/catalogue.ts'
import { memoryContent, scriptedAsker } from '../tools/testing.ts'
import { runToolLoop } from './loop.ts'
import { gitTestEnv } from '../../test/git-test-env.ts'

const TERMINAL = new Set(['tool.completed', 'tool.failed', 'tool.denied'])

function scriptedClient(turns: ProviderContent[][]): ProviderClient & { requests: ProviderRequest[] } {
  const requests: ProviderRequest[] = []
  let n = 0
  return {
    requests,
    provider: 'anthropic',
    adapterVersion: 'stub@1',
    capabilities: { streaming: false, editPolicy: 'verbatim' as never },
    async invokeOnce(req, attempt): Promise<InvocationResult> {
      requests.push(structuredClone({ ...req, signal: undefined }))
      const content = turns.shift()
      if (!content) throw new Error('script exhausted')
      n += 1
      return {
        invocationId: req.correlation.invocationId, attempt, provider: 'anthropic', requestedModel: req.model,
        startedAt: '2026-09-27T12:00:00.000Z', latencyMs: 5, status: 'completed', messageId: `msg_${n}`,
        servedModel: req.model, usage: fromAnthropicUsage({ input_tokens: 10, output_tokens: 5 }).usage,
        usageAnomalies: [], content,
        stopReason: fromAnthropicStopReason(content.some(c => c.type === 'tool_use') ? 'tool_use' : 'end_turn'),
      }
    },
  }
}

const use = (id: string, name: string, input: unknown): ProviderContent => ({ type: 'tool_use', id, name, input })

let ws: string
let native: NativeTools

beforeAll(async () => {
  ws = await realpath(await mkdtemp(join(tmpdir(), 'agt-b3-e2e-')))
  await writeFile(join(ws, 'hello.ts'), "export const greeting = 'hello'\n")
  const git = (...a: string[]) => Bun.spawnSync(['git', '-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: ws, env: gitTestEnv() })
  git('init', '-q'); git('add', '.'); git('commit', '-qm', 'init')
  native = createNativeTools()
})

afterAll(async () => {
  await native.dispose()
  await rm(ws, { recursive: true, force: true })
})

describe('M1 — the native session acts on a repository (offline)', () => {
  test('read → approved patch → approved shell → floor refusal → git read → outside read refused', async () => {
    const patch = [
      '*** Begin Patch',
      '*** Update File: hello.ts',
      '@@',
      "-export const greeting = 'hello'",
      "+export const greeting = 'hello, world'",
      '*** End Patch',
    ].join('\n')
    const client = scriptedClient([
      [use('t1', 'file__read', { path: 'hello.ts' })],
      [use('t2', 'file__patch', { patch })],
      [use('t3', 'shell__start', { command: 'cat hello.ts && git status --short' })],
      [use('t4', 'shell__start', { command: 'echo ok; rm -rf ~' })],
      [use('t5', 'git__status', {})],
      [use('t6', 'file__read', { path: '/etc/hostname' })],
      [{ type: 'text', text: 'done' }],
    ])
    // The person approves the patch and the first shell command once each, and nothing else.
    const asker = scriptedAsker([{ answered: true, choice: 0 }, { answered: true, choice: 0 }])
    const events: AgentisticsEvent[] = []
    const journal = { async append(b: readonly AgentisticsEvent[]) { events.push(...b); return { written: b.length, duplicates: 0 } } }

    const r = await runToolLoop({
      client, model: 'claude-test', maxTokens: 1000, credential: { provider: 'anthropic', id: 't' } as unknown as CredentialRef,
      messages: [{ role: 'user', content: 'greet the world' }],
      tools: native.tools,
      limits: { maxTurns: 10, maxToolCalls: 10, wallTimeMs: 30_000 },
      policy: createPolicy({ layers: [], home: '/home/nobody-e2e' }),
      content: memoryContent(),
      asker,
      journal,
      runtimeVersion: 'runtime@e2e',
      workspaceRoot: ws,
      cwd: ws,
      scope: { runId: 'run_e2e', sessionId: 'ses_e2e' },
      retry: { sleep: async () => {} },
    })

    expect(r.status).toBe('end-turn')
    const byId = Object.fromEntries(r.calls.map(c => [c.toolUseId, c]))
    expect(byId.t1!.status).toBe('completed')
    expect(byId.t2!.status).toBe('completed')
    expect(byId.t3!.status).toBe('completed')
    expect(byId.t4!.status).toBe('denied')
    expect(byId.t5!.status).toBe('completed')
    expect(byId.t6!.status).toBe('denied')

    // The patch really landed, and the approved shell command saw it.
    expect(await readFile(join(ws, 'hello.ts'), 'utf8')).toBe("export const greeting = 'hello, world'\n")
    const resultOf = (id: string) => client.requests
      .flatMap(q => q.messages)
      .flatMap(m => (typeof m.content === 'string' ? [] : m.content))
      .find((p): p is Extract<ProviderMessagePart, { type: 'tool_result' }> => p.type === 'tool_result' && p.toolUseId === id)!
    expect(resultOf('t3').content).toContain("hello, world")
    expect(resultOf('t3').content).toContain('M hello.ts')

    // Exactly two questions reached the person: the patch and the first command. The `rm -rf ~`
    // was refused by the floor without asking anyone, and the git read needed no approval.
    expect(asker.asked).toHaveLength(2)
    expect(resultOf('t4').isError).toBe(true)
    expect(resultOf('t4').content.length).toBeGreaterThan(10)
    expect(resultOf('t6').isError).toBe(true)
    expect(resultOf('t5').content).toContain('hello.ts')

    // One tool.requested and exactly one terminal event per call, and no content in any event.
    for (const c of r.calls) {
      const mine = events.filter(e => (e.data as { toolExecutionId?: string }).toolExecutionId === c.toolExecutionId)
      expect(mine.filter(e => e.type === 'tool.requested')).toHaveLength(1)
      expect(mine.filter(e => TERMINAL.has(e.type))).toHaveLength(1)
    }
    expect(JSON.stringify(events)).not.toContain('hello, world')
  })
  test("the agent's shell sees nothing of the host environment unless the host passes it", async () => {
    process.env.AGT_E2E_FAKE_SECRET = 'sk-e2e-should-not-leak'
    const run = async (tools: NativeTools) => {
      const client = scriptedClient([
        [use('s1', 'shell__start', { command: 'echo "[${AGT_E2E_FAKE_SECRET:-}]"' })],
        [{ type: 'text', text: 'done' }],
      ])
      await runToolLoop({
        client, model: 'claude-test', maxTokens: 1000, credential: { provider: 'anthropic', id: 't' } as unknown as CredentialRef,
        messages: [{ role: 'user', content: 'x' }], tools: tools.tools,
        limits: { maxTurns: 5, maxToolCalls: 5, wallTimeMs: 30_000 },
        policy: createPolicy({ layers: [{ name: 'test', rules: [{ id: 'allow-echo', effect: 'allow', match: { commandPrefix: ['echo'] } }] }] }),
        content: memoryContent(), journal: null, runtimeVersion: 'runtime@e2e', workspaceRoot: ws, cwd: ws,
        retry: { sleep: async () => {} },
      })
      const res = client.requests[1]!.messages.at(-1)!.content as ProviderMessagePart[]
      return (res[0] as { content: string }).content
    }
    const bare = createNativeTools()
    const passed = createNativeTools({ env: { ...process.env } })
    try {
      expect(await run(bare)).toContain('[]')
      expect(await run(passed)).toContain('[sk-e2e-should-not-leak]')
    } finally {
      delete process.env.AGT_E2E_FAKE_SECRET
      await bare.dispose(); await passed.dispose()
    }
  })
})
