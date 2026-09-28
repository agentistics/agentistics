/**
 * session/resume.test.ts — B4.2: window/cursor paging (`openSession` / `olderMessages`) and repair
 * of a run whose driver died mid-tool (`repairInterruptedRun`), against a REAL sqlite store and a
 * REAL file content store (same shape as `runtime.test.ts`).
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fromAnthropicStopReason, fromAnthropicUsage, type AgentisticsEvent } from '@agentistics/core'
import type { CredentialRef, InvocationResult, ProviderClient, ProviderContent, ProviderRequest } from '../provider/client.ts'
import { createPolicy } from '../policy/index.ts'
import { createNativeTools, type NativeTools } from '../tools/catalogue.ts'
import { gitTestEnv } from '../../test/git-test-env.ts'
import { createFileContentStore, type FileContentStore } from './content-store.ts'
import { createRunScheduler } from './scheduler.ts'
import { openSqliteSessionStore } from './sqlite-store.ts'
import { createSessionRuntime, type CreateSessionRuntimeDeps } from './runtime.ts'
import { openSession, olderMessages, repairInterruptedRun, type ResumeDeps } from './resume.ts'
import type { SessionStore } from './types.ts'

const use = (id: string, name: string, input: unknown): ProviderContent => ({ type: 'tool_use', id, name, input })

function scriptedClient(turns: ProviderContent[][], capture?: { requests: ProviderRequest[] }): ProviderClient {
  let n = 0
  return {
    provider: 'anthropic',
    adapterVersion: 'stub@1',
    capabilities: { streaming: false, editPolicy: 'verbatim' as never },
    async invokeOnce(req, attempt): Promise<InvocationResult> {
      capture?.requests.push(req)
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

let ws: string
let native: NativeTools
let dataDir: string
let store: SessionStore
let content: FileContentStore

function baseDeps(overrides: Partial<CreateSessionRuntimeDeps> = {}): CreateSessionRuntimeDeps {
  return {
    store,
    content,
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

function resumeDeps(overrides: Partial<ResumeDeps> = {}): ResumeDeps {
  return { store, content, journal: null, runtimeVersion: 'runtime@b4-test', ...overrides }
}

beforeAll(async () => {
  ws = await realpath(await mkdtemp(join(tmpdir(), 'agt-b4-resume-ws-')))
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
  dataDir = await mkdtemp(join(tmpdir(), 'agt-b4-resume-data-'))
  store = openSqliteSessionStore(join(dataDir, 'sessions.db'))
  content = createFileContentStore(join(dataDir, 'content'))
})

afterEach(async () => {
  store.close()
  await rm(dataDir, { recursive: true, force: true })
})

async function newSession() {
  const runtime = createSessionRuntime(baseDeps())
  return runtime.create({
    workspaceRoot: ws, cwd: ws, provider: 'anthropic', model: 'claude-test',
    credential: { provider: 'anthropic', id: 't' } as unknown as CredentialRef,
  })
}

describe('openSession / olderMessages — window + cursor paging', () => {
  test('unknown session -> null', async () => {
    expect(await openSession(resumeDeps(), 'ses_does_not_exist')).toBeNull()
  })

  test('a fresh session opens with metadata and an empty window', async () => {
    const session = await newSession()
    const opened = await openSession(resumeDeps(), session.sessionId)
    expect(opened).not.toBeNull()
    expect(opened!.session.sessionId).toBe(session.sessionId)
    expect(opened!.messages).toEqual([])
    expect(opened!.nextBefore).toBeUndefined()
    expect(opened!.missing).toBeUndefined()
  })

  test('a small window plus olderMessages walks the whole history exactly once, oldest to newest overall', async () => {
    const session = await newSession()
    // 7 plain user/assistant pairs of messages, appended directly (no model call needed).
    for (let i = 0; i < 7; i++) {
      const userRef = (await content.put(JSON.stringify({ role: 'user', content: `q${i}` })))!
      await store.appendMessage({ sessionId: session.sessionId, runId: 'run_x', role: 'user', content: userRef, createdAt: new Date().toISOString() })
      const asstRef = (await content.put(JSON.stringify({ role: 'assistant', content: `a${i}` })))!
      await store.appendMessage({ sessionId: session.sessionId, runId: 'run_x', role: 'assistant', content: asstRef, createdAt: new Date().toISOString() })
    }
    // 14 messages total (seq 1..14). Window of 5 -> newest 5 (seq 10..14).
    const opened = await openSession(resumeDeps(), session.sessionId, { window: 5 })
    expect(opened!.messages.map(m => m.seq)).toEqual([10, 11, 12, 13, 14])
    expect(opened!.nextBefore).toBe(10)

    // Walk backwards with olderMessages until nextBefore disappears, collecting every seq.
    const seen = [...opened!.messages.map(m => m.seq)]
    let before = opened!.nextBefore!
    for (;;) {
      const page = await olderMessages(resumeDeps(), session.sessionId, before, 5)
      seen.unshift(...page.messages.map(m => m.seq))
      if (page.nextBefore === undefined) break
      before = page.nextBefore
    }
    expect(seen).toEqual(Array.from({ length: 14 }, (_, i) => i + 1))
  })

  test('window clamps to the max (200) and to the default (50) — never zero, never unbounded', async () => {
    const session = await newSession()
    for (let i = 0; i < 3; i++) {
      const ref = (await content.put(JSON.stringify({ role: 'user', content: `m${i}` })))!
      await store.appendMessage({ sessionId: session.sessionId, runId: 'run_x', role: 'user', content: ref, createdAt: new Date().toISOString() })
    }
    const zero = await openSession(resumeDeps(), session.sessionId, { window: 0 })
    expect(zero!.messages).toHaveLength(3) // 0 reads as the default (50), not "nothing"
    const huge = await openSession(resumeDeps(), session.sessionId, { window: 100_000 })
    expect(huge!.messages).toHaveLength(3) // clamped to 200, still only 3 exist
  })

  test('a message body missing from the content store is skipped, never invented, and reported in `missing`', async () => {
    const session = await newSession()
    const goodRef = (await content.put(JSON.stringify({ role: 'user', content: 'real' })))!
    await store.appendMessage({ sessionId: session.sessionId, runId: 'run_x', role: 'user', content: goodRef, createdAt: new Date().toISOString() })
    // A ContentRef whose bytes were never actually put — a plausible sha256 the store never wrote.
    const ghostSha = '0'.repeat(64)
    await store.appendMessage({
      sessionId: session.sessionId, runId: 'run_x', role: 'assistant',
      content: { sha256: ghostSha, bytes: 4 }, createdAt: new Date().toISOString(),
    })

    const opened = await openSession(resumeDeps(), session.sessionId)
    expect(opened!.messages.map(m => m.seq)).toEqual([1]) // seq 2's body could not be read
    expect(opened!.missing).toEqual([2])
    // The one readable message is exactly what was written — nothing fabricated in its place.
    expect(opened!.messages[0]!.message).toEqual({ role: 'user', content: 'real' })
  })
})

describe('repairInterruptedRun', () => {
  async function danglingRun(): Promise<{ sessionId: string; runId: string; t1ExecId: string; t2ExecId: string }> {
    const session = await newSession()
    const runId = 'run_dangling'
    await store.createRun({ runId, sessionId: session.sessionId, startedAt: new Date().toISOString(), status: 'running', turns: 1, toolCalls: 3 })

    const assistantMsg = {
      role: 'assistant',
      content: [
        { type: 'text', text: 'running three things' },
        { type: 'tool_use', id: 't1', name: 'file__read', input: { path: 'hello.ts' } },
        { type: 'tool_use', id: 't2', name: 'shell__start', input: { command: 'sleep 999' } },
        { type: 'tool_use', id: 't3', name: 'file__read', input: { path: 'never-reached.ts' } },
      ],
    }
    const asstRef = (await content.put(JSON.stringify(assistantMsg)))!
    await store.appendMessage({ sessionId: session.sessionId, runId, role: 'assistant', content: asstRef, createdAt: new Date().toISOString() })

    // t1: settled, with a real recorded result.
    const t1ExecId = 'tx_t1'
    const t1Result = (await content.put('hello.ts says: hello'))!
    await store.recordToolCall({ runId, toolExecutionId: t1ExecId, toolUseId: 't1', name: 'file__read', state: 'started' })
    await store.recordToolCall({ runId, toolExecutionId: t1ExecId, toolUseId: 't1', name: 'file__read', state: 'settled', result: t1Result, isError: false })

    // t2: started, never settled — the process died mid-call.
    const t2ExecId = 'tx_t2'
    await store.recordToolCall({ runId, toolExecutionId: t2ExecId, toolUseId: 't2', name: 'shell__start', state: 'started' })

    // t3: no ToolCallRecord at all — the loop never got to it.

    return { sessionId: session.sessionId, runId, t1ExecId, t2ExecId }
  }

  test('splits settled / started / never-started, journals the interruption, and ends the run lost', async () => {
    const { sessionId, runId, t2ExecId } = await danglingRun()
    const events: AgentisticsEvent[] = []
    const journal = { async append(b: readonly AgentisticsEvent[]) { events.push(...b); return { written: b.length, duplicates: 0 } } }

    const report = await repairInterruptedRun(resumeDeps({ journal }), sessionId)

    expect(report.repaired).toBe(true)
    expect(report.runId).toBe(runId)
    expect(report.settled).toBe(1)
    expect(report.interrupted).toBe(1)
    expect(report.notStarted).toBe(1)
    expect(report.sentence).toContain(runId)

    // The run ended lost, in the store.
    const run = await store.getRun(runId)
    expect(run?.status).toBe('lost')

    // Exactly one tool.failed (for t2) + one run.ended, in that order.
    expect(events.map(e => e.type)).toEqual(['tool.failed', 'run.ended'])
    const failedEvent = events[0]!
    expect(failedEvent.data).toEqual({ toolExecutionId: t2ExecId, status: 'cancelled', errorClass: 'killed' })
    expect('durationMs' in (failedEvent.data as object)).toBe(false)
    expect(failedEvent.sessionId).toBe(sessionId)
    expect(failedEvent.runId).toBe(runId)

    const endedEvent = events[1]!
    expect(endedEvent.type).toBe('run.ended')
    expect(endedEvent.data).toEqual({ status: 'lost' })
    expect(endedEvent.sessionId).toBe(sessionId)
    expect(endedEvent.runId).toBe(runId)

    // The tool.failed event's id is exactly what the loop's own emitter would have minted for
    // this call, in this scope — computed independently here, never imported from resume.ts.
    const { toolScopeKey } = await import('../loop/emit.ts')
    const { deriveEventId } = await import('@agentistics/core')
    const expectedId = deriveEventId({
      sourceKind: 'runtime', sourceId: 'agentistics',
      sourceRef: `${toolScopeKey({ sessionId, runId })}:tx:${t2ExecId}`, type: 'tool.failed',
    })
    expect(failedEvent.eventId).toBe(expectedId)

    // The repaired tool_result message is persisted as the newest message of the run.
    const opened = await openSession(resumeDeps(), sessionId)
    const last = opened!.messages[opened!.messages.length - 1]!.message
    expect(last.role).toBe('user')
    expect(Array.isArray(last.content)).toBe(true)
    const parts = last.content as { type: string; toolUseId?: string; content?: string; isError?: boolean }[]
    expect(parts.map(p => p.toolUseId)).toEqual(['t1', 't2', 't3'])

    const t1 = parts[0]!
    expect(t1.content).toBe('hello.ts says: hello') // the REAL recorded result, verbatim
    expect(t1.isError).toBe(false)

    const t2 = parts[1]!
    expect(t2.isError).toBe(true)
    expect(t2.content).toBe(
      'This call was interrupted: the process running the session ended before it finished. It may or may not have taken effect — check before repeating it.',
    )

    const t3 = parts[2]!
    expect(t3.isError).toBe(true)
    expect(t3.content).toBe('Not run: the process ended before this call started.')
  })

  test('idempotent: a second call repairs nothing — same run, no new message, no new events', async () => {
    const { sessionId, runId } = await danglingRun()
    const events: AgentisticsEvent[] = []
    const journal = { async append(b: readonly AgentisticsEvent[]) { events.push(...b); return { written: b.length, duplicates: 0 } } }
    const deps = resumeDeps({ journal })

    const first = await repairInterruptedRun(deps, sessionId)
    expect(first.repaired).toBe(true)
    const messagesAfterFirst = (await openSession(deps, sessionId))!.messages.length
    const eventsAfterFirst = events.length

    const second = await repairInterruptedRun(deps, sessionId)
    expect(second.repaired).toBe(false)
    expect(second.runId).toBe(runId)
    expect(second.settled).toBe(0)
    expect(second.interrupted).toBe(0)
    expect(second.notStarted).toBe(0)

    const messagesAfterSecond = (await openSession(deps, sessionId))!.messages.length
    expect(messagesAfterSecond).toBe(messagesAfterFirst)
    expect(events.length).toBe(eventsAfterFirst)

    const run = await store.getRun(runId)
    expect(run?.status).toBe('lost') // untouched by the second, no-op call
  })

  test('nothing running -> repaired:false, and says so', async () => {
    const session = await newSession()
    const report = await repairInterruptedRun(resumeDeps(), session.sessionId)
    expect(report.repaired).toBe(false)
    expect(report.runId).toBeNull()
    expect(report.sentence.length).toBeGreaterThan(0)
  })

  test('a running run with no dangling tool_use is still ended lost', async () => {
    const session = await newSession()
    const runId = 'run_no_tools'
    await store.createRun({ runId, sessionId: session.sessionId, startedAt: new Date().toISOString(), status: 'running', turns: 1, toolCalls: 0 })
    // The model's last turn was plain text — killed after it answered but before run.ended landed.
    const asstRef = (await content.put(JSON.stringify({ role: 'assistant', content: [{ type: 'text', text: 'sure, done' }] })))!
    await store.appendMessage({ sessionId: session.sessionId, runId, role: 'assistant', content: asstRef, createdAt: new Date().toISOString() })

    const messagesBefore = (await openSession(resumeDeps(), session.sessionId))!.messages.length
    const report = await repairInterruptedRun(resumeDeps(), session.sessionId)
    // Nothing to repair onto — no message is invented for a turn with no dangling tool_use.
    const messagesAfter = (await openSession(resumeDeps(), session.sessionId))!.messages.length
    expect(messagesAfter).toBe(messagesBefore)
    expect(report.repaired).toBe(true)
    expect(report.settled + report.interrupted + report.notStarted).toBe(0)
    const run = await store.getRun(runId)
    expect(run?.status).toBe('lost')
  })

  test('a resumed session can run() again: the repaired tool_results reach the model, and no tool_use is ever sent without its tool_result', async () => {
    const { sessionId } = await danglingRun()
    await repairInterruptedRun(resumeDeps(), sessionId)

    const captured: { requests: ProviderRequest[] } = { requests: [] }
    const runtime = createSessionRuntime(baseDeps({
      clientFor: () => scriptedClient([[{ type: 'text', text: 'continuing' }]], captured),
    }))
    const outcome = await runtime.run(sessionId, 'please continue')
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.status).toBe('completed')

    const firstRequest = captured.requests[0]!
    const seenToolUseIds = new Set<string>()
    const seenToolResultIds = new Set<string>()
    for (const m of firstRequest.messages) {
      if (typeof m.content === 'string') continue
      for (const part of m.content) {
        if (part.type === 'tool_use') seenToolUseIds.add(part.id)
        if (part.type === 'tool_result') seenToolResultIds.add(part.toolUseId)
      }
    }
    // Every tool_use the model is shown already has its tool_result in the same request.
    for (const id of seenToolUseIds) expect(seenToolResultIds.has(id)).toBe(true)
    expect(seenToolResultIds).toEqual(new Set(['t1', 't2', 't3']))

    // The new user turn ('please continue') is the last message sent.
    const lastSent = firstRequest.messages[firstRequest.messages.length - 1]!
    expect(lastSent).toEqual({ role: 'user', content: 'please continue' })
  })
})
