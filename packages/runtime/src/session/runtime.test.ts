/**
 * session/runtime.test.ts — B4.1's own e2e: the REAL loop, the REAL v1 catalogue, a REAL sqlite
 * store and a REAL file content store, driven by a scripted model and a scripted person — the same
 * shape as `loop/e2e.test.ts`. Nothing here is a double except the model and the person.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  classifyProviderError,
  fromAnthropicStopReason,
  fromAnthropicUsage,
  type AgentisticsEvent,
} from '@agentistics/core'
import type { CredentialRef, InvocationResult, ProviderClient, ProviderContent, ProviderRequest } from '../provider/client.ts'
import { createPolicy } from '../policy/index.ts'
import { createNativeTools, type NativeTools } from '../tools/catalogue.ts'
import { scriptedAsker } from '../tools/testing.ts'
import { gitTestEnv } from '../../test/git-test-env.ts'
import { createFileContentStore } from './content-store.ts'
import { createRunScheduler } from './scheduler.ts'
import { openSqliteSessionStore } from './sqlite-store.ts'
import { createSessionRuntime, type CreateSessionRuntimeDeps, type SessionRuntime } from './runtime.ts'
import type { SessionStore } from './types.ts'

function scriptedClient(turns: ProviderContent[][]): ProviderClient {
  let n = 0
  return {
    provider: 'anthropic',
    adapterVersion: 'stub@1',
    capabilities: { streaming: false, editPolicy: 'verbatim' as never },
    async invokeOnce(req, attempt): Promise<InvocationResult> {
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

/** A client whose one attempt hangs until the caller's signal aborts (for `cancel()`). */
function hangingClient(): ProviderClient {
  return {
    provider: 'anthropic',
    adapterVersion: 'stub@1',
    capabilities: { streaming: false, editPolicy: 'verbatim' as never },
    async invokeOnce(req: ProviderRequest, attempt): Promise<InvocationResult> {
      if (req.signal?.aborted) {
        return {
          invocationId: req.correlation.invocationId, attempt, provider: 'anthropic', requestedModel: req.model,
          startedAt: '2026-09-27T12:00:00.000Z', latencyMs: 1, status: 'failed',
          error: classifyProviderError({ transport: 'aborted' }),
        }
      }
      return await new Promise<InvocationResult>(resolve => {
        const timer = setTimeout(() => resolve({
          invocationId: req.correlation.invocationId, attempt, provider: 'anthropic', requestedModel: req.model,
          startedAt: '2026-09-27T12:00:00.000Z', latencyMs: 200, status: 'completed', messageId: 'msg_late',
          servedModel: req.model, usage: fromAnthropicUsage({ input_tokens: 1, output_tokens: 1 }).usage,
          usageAnomalies: [], content: [{ type: 'text', text: 'too late' }], stopReason: fromAnthropicStopReason('end_turn'),
        }), 2000)
        req.signal?.addEventListener('abort', () => {
          clearTimeout(timer)
          resolve({
            invocationId: req.correlation.invocationId, attempt, provider: 'anthropic', requestedModel: req.model,
            startedAt: '2026-09-27T12:00:00.000Z', latencyMs: 1, status: 'failed',
            error: classifyProviderError({ transport: 'aborted' }),
          })
        }, { once: true })
      })
    },
  }
}

const use = (id: string, name: string, input: unknown): ProviderContent => ({ type: 'tool_use', id, name, input })

let ws: string
let native: NativeTools
let dataDir: string
let store: SessionStore

function baseDeps(overrides: Partial<CreateSessionRuntimeDeps> = {}): CreateSessionRuntimeDeps {
  return {
    store,
    content: createFileContentStore(join(dataDir, 'content')),
    journal: null,
    clientFor: () => scriptedClient([[{ type: 'text', text: 'done' }]]),
    tools: native.tools,
    policyFactory: () => createPolicy({ layers: [], home: '/home/nobody-b4' }),
    runtimeVersion: 'runtime@b4-test',
    scheduler: createRunScheduler({ ceiling: 4 }),
    retry: { sleep: async () => {} },
    ...overrides,
  }
}

beforeAll(async () => {
  ws = await realpath(await mkdtemp(join(tmpdir(), 'agt-b4-runtime-ws-')))
  await writeFile(join(ws, 'hello.ts'), "export const greeting = 'hello'\n")
  const git = (...a: string[]) => Bun.spawnSync(['git', '-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: ws, env: gitTestEnv() })
  git('init', '-q'); git('add', '.'); git('commit', '-qm', 'init')
  native = createNativeTools()
})

afterAll(async () => {
  await native.dispose()
  await rm(ws, { recursive: true, force: true })
})

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'agt-b4-runtime-data-'))
  store = openSqliteSessionStore(join(dataDir, 'sessions.db'))
})

afterEach(async () => {
  store.close()
  await rm(dataDir, { recursive: true, force: true })
})

describe('createSessionRuntime — create, run, events', () => {
  test('a model-only run: session.started -> run.started -> model.* -> run.ended, in order', async () => {
    const events: AgentisticsEvent[] = []
    const tapped: AgentisticsEvent[] = []
    const journal = { async append(b: readonly AgentisticsEvent[]) { events.push(...b); return { written: b.length, duplicates: 0 } } }
    const runtime = createSessionRuntime(baseDeps({ journal, onEvent: e => tapped.push(e) }))

    const session = await runtime.create({
      workspaceRoot: ws, cwd: ws, provider: 'anthropic', model: 'claude-test',
      credential: { provider: 'anthropic', id: 't' } as unknown as CredentialRef,
    })
    expect(session.status).toBe('open')
    expect(session.sessionId).toMatch(/^ses_[0-9a-f]{32}$/)
    expect(events.map(e => e.type)).toEqual(['session.started'])

    const outcome = await runtime.run(session.sessionId, 'hello there')
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.status).toBe('completed')
    expect(outcome.stop).toBe('end-turn')

    expect(events.map(e => e.type)).toEqual([
      'session.started', 'run.started', 'model.invoked', 'model.completed', 'run.ended',
    ])
    // The tee: `onEvent` sees exactly what the journal sees, in the same order.
    expect(tapped.map(e => e.type)).toEqual(events.map(e => e.type))
    expect(tapped.map(e => e.eventId)).toEqual(events.map(e => e.eventId))

    const stored = await runtime.get(session.sessionId)
    expect(stored?.messageCount).toBe(2) // the user turn + the final assistant turn
    expect(stored?.runCount).toBe(1)
    expect(stored?.lastRunId).toBe(outcome.runId)
  })

  test('a person-approved tool call: the full event sequence, and the message window persisted incrementally', async () => {
    const patch = [
      '*** Begin Patch',
      '*** Update File: hello.ts',
      '@@',
      "-export const greeting = 'hello'",
      "+export const greeting = 'hello, session'",
      '*** End Patch',
    ].join('\n')
    // `file.patch` refuses to touch a file this session never read (its own checkpoint rule), so
    // the script reads it first — exactly `loop/e2e.test.ts`'s own shape.
    const client = scriptedClient([
      [use('t0', 'file__read', { path: 'hello.ts' })],
      [use('t1', 'file__patch', { patch })],
      [{ type: 'text', text: 'done' }],
    ])
    const asker = scriptedAsker([{ answered: true, choice: 0 }])

    const events: AgentisticsEvent[] = []
    const journal = { async append(b: readonly AgentisticsEvent[]) { events.push(...b); return { written: b.length, duplicates: 0 } } }
    const runtime = createSessionRuntime(baseDeps({ journal, clientFor: () => client, asker }))

    const session = await runtime.create({
      workspaceRoot: ws, cwd: ws, provider: 'anthropic', model: 'claude-test',
      credential: { provider: 'anthropic', id: 't' } as unknown as CredentialRef,
    })
    const outcome = await runtime.run(session.sessionId, 'patch the greeting')
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.status).toBe('completed')
    // Only the patch asks — a read is `auto`.
    expect(asker.asked).toHaveLength(1)

    expect(events.map(e => e.type)).toEqual([
      'session.started', 'run.started',
      'model.invoked', 'model.completed',
      'tool.requested', 'policy.requested', 'policy.approved', 'tool.approved', 'tool.completed', // the read (auto)
      'model.invoked', 'model.completed',
      'tool.requested', 'policy.requested', 'policy.approved', 'tool.approved', 'tool.completed', // the patch (asked)
      'model.invoked', 'model.completed',
      'run.ended',
    ])
    // No conversation content anywhere in the journal.
    expect(JSON.stringify(events)).not.toContain('hello, session')

    // Six messages, in order: user, assistant(read), tool_result, assistant(patch), tool_result, assistant(text).
    const win = await store.listMessages(session.sessionId, { limit: 10 })
    expect(win.messages.map(m => m.role)).toEqual(['user', 'assistant', 'user', 'assistant', 'user', 'assistant'])
    expect(win.messages.map(m => m.seq)).toEqual([1, 2, 3, 4, 5, 6])

    // Every tool call this run made is on disk, settled.
    const calls = await store.listToolCalls(outcome.runId)
    expect(calls).toHaveLength(2)
    expect(calls.every(c => c.state === 'settled')).toBe(true)
    const patchCall = calls.find(c => c.toolUseId === 't1')!
    expect(patchCall.isError).toBe(false)
  })

  test('the assistant turn is persisted BEFORE its tool runs — a policy ask mid-call already sees it', async () => {
    const session = await createSessionRuntime(baseDeps()).create({
      workspaceRoot: ws, cwd: ws, provider: 'anthropic', model: 'claude-test',
      credential: { provider: 'anthropic', id: 't' } as unknown as CredentialRef,
    })
    let sawAssistantDuringTheCall = false
    const asker = {
      async ask() {
        const win = await store.listMessages(session.sessionId, { limit: 10 })
        sawAssistantDuringTheCall = win.messages.some(m => m.role === 'assistant')
        return { answered: true, choice: 0 } as const
      },
    }
    // `echo` is a harmless builtin the policy allows without asking (`policy.ts`'s own default
    // table) — `cat` is not, so it is what actually reaches the person.
    const runtime = createSessionRuntime(baseDeps({
      clientFor: () => scriptedClient([[use('t3', 'shell__start', { command: 'cat hello.ts' })], [{ type: 'text', text: 'done' }]]),
      asker,
    }))
    const outcome = await runtime.run(session.sessionId, 'run something')
    expect(outcome.ok).toBe(true)
    expect(sawAssistantDuringTheCall).toBe(true)
  })

  test('model failure -> failed', async () => {
    const failing: ProviderClient = {
      provider: 'anthropic', adapterVersion: 'stub@1', capabilities: { streaming: false, editPolicy: 'verbatim' as never },
      async invokeOnce(req, attempt): Promise<InvocationResult> {
        return {
          invocationId: req.correlation.invocationId, attempt, provider: 'anthropic', requestedModel: req.model,
          startedAt: '2026-09-27T12:00:00.000Z', latencyMs: 1, status: 'failed',
          error: classifyProviderError({ sdkRejected: true }),
        }
      },
    }
    const runtime = createSessionRuntime(baseDeps({ clientFor: () => failing }))
    const session = await runtime.create({
      workspaceRoot: ws, cwd: ws, provider: 'anthropic', model: 'claude-test',
      credential: { provider: 'anthropic', id: 't' } as unknown as CredentialRef,
    })
    const outcome = await runtime.run(session.sessionId, 'hi')
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.status).toBe('failed')
    expect(outcome.stop).toBe('model-failed')

    const run = await store.getRun(outcome.runId)
    expect(run?.status).toBe('failed')
  })

  test('cancel(runId) aborts an in-flight run -> abandoned', async () => {
    const runtime = createSessionRuntime(baseDeps({
      clientFor: () => hangingClient(),
      mintId: prefix => `${prefix}fixed`,
    }))
    const session = await runtime.create({
      workspaceRoot: ws, cwd: ws, provider: 'anthropic', model: 'claude-test',
      credential: { provider: 'anthropic', id: 't' } as unknown as CredentialRef,
    })
    const runPromise = runtime.run(session.sessionId, 'hang please')
    await new Promise(resolve => setTimeout(resolve, 20))
    const cancelled = runtime.cancel('run_fixed')
    expect(cancelled).toBe(true)

    const outcome = await runPromise
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.status).toBe('abandoned')
    expect(outcome.stop).toBe('aborted')

    const run = await store.getRun(outcome.runId)
    expect(run?.status).toBe('abandoned')
  })

  test('cancel() on an unknown or already-finished run refuses quietly (false), never throws', async () => {
    const runtime = createSessionRuntime(baseDeps())
    expect(runtime.cancel('run_never_existed')).toBe(false)
  })

  test('the scheduler ceiling refuses a new run while others are in flight', async () => {
    const runtime = createSessionRuntime(baseDeps({
      clientFor: () => hangingClient(),
      scheduler: createRunScheduler({ ceiling: 1 }),
    }))
    const session = await runtime.create({
      workspaceRoot: ws, cwd: ws, provider: 'anthropic', model: 'claude-test',
      credential: { provider: 'anthropic', id: 't' } as unknown as CredentialRef,
    })
    const first = runtime.run(session.sessionId, 'one')
    await new Promise(resolve => setTimeout(resolve, 10))
    const second = await runtime.run(session.sessionId, 'two')
    expect(second.ok).toBe(false)
    if (!second.ok) expect(second.reason).toBe('at-ceiling')

    // Clean up the still-running first call so the test process can exit.
    const runs = await store.latestRun(session.sessionId)
    if (runs) runtime.cancel(runs.runId)
    await first
  })

  test('run() refuses a session that does not exist, or one that has finished', async () => {
    const runtime = createSessionRuntime(baseDeps())
    const missing = await runtime.run('ses_does_not_exist', 'hi')
    expect(missing.ok).toBe(false)
    if (!missing.ok) expect(missing.reason).toBe('session-not-found')

    const session = await runtime.create({
      workspaceRoot: ws, cwd: ws, provider: 'anthropic', model: 'claude-test',
      credential: { provider: 'anthropic', id: 't' } as unknown as CredentialRef,
    })
    await runtime.finish(session.sessionId)
    const ended = await runtime.get(session.sessionId)
    expect(ended?.status).toBe('ended')

    const afterFinish = await runtime.run(session.sessionId, 'too late')
    expect(afterFinish.ok).toBe(false)
    if (!afterFinish.ok) expect(afterFinish.reason).toBe('session-not-open')
  })

  test('fail() ends the session as failed, and both emit session.ended (never a wider vocabulary)', async () => {
    const events: AgentisticsEvent[] = []
    const journal = { async append(b: readonly AgentisticsEvent[]) { events.push(...b); return { written: b.length, duplicates: 0 } } }
    const runtime = createSessionRuntime(baseDeps({ journal }))
    const session = await runtime.create({
      workspaceRoot: ws, cwd: ws, provider: 'anthropic', model: 'claude-test',
      credential: { provider: 'anthropic', id: 't' } as unknown as CredentialRef,
    })
    await runtime.fail(session.sessionId)
    const after = await runtime.get(session.sessionId)
    expect(after?.status).toBe('failed')
    expect(events.map(e => e.type)).toEqual(['session.started', 'session.ended'])
  })
})
