/**
 * cli-code.test.ts — `agentop code` (B4.4), fully offline: a scripted `ProviderClient`, a temp
 * sqlite store + content store, and a scripted stdin — no real key, no real tty, no real process
 * signal. Mirrors the shape of `packages/runtime/src/loop/e2e.test.ts` / `session/runtime.test.ts`.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gitTestEnv } from '@agentistics/core/gitTestEnv'
import { fromAnthropicStopReason, fromAnthropicUsage, type AgentisticsEvent } from '@agentistics/core'
import {
  createFileContentStore,
  openSqliteSessionStore,
  type InvocationResult,
  type ProviderClient,
  type ProviderContent,
  type ProviderJournalSink,
  type ProviderRequest,
  type ProviderStreamEvent,
  type SessionRecord,
  type SessionStore,
} from '@agentistics/runtime'
import { createRuntimeHost } from './runtime-host.ts'
import { runCode, type CodeCliDeps, type CodeHostFactory } from './cli-code.ts'

// ── A scripted, STREAMING provider client (agentop code always streams — see cli-code.ts's module
// doc: `onStreamEvent`/`delta` frames only fire when `client.capabilities.streaming` is true) ─────

interface ScriptedTurn { content: ProviderContent[]; deltas?: string[] }

function scriptedStreamingClient(turns: ScriptedTurn[]): ProviderClient & { requests: ProviderRequest[] } {
  const queue = [...turns]
  const requests: ProviderRequest[] = []
  let n = 0
  return {
    requests,
    provider: 'anthropic',
    adapterVersion: 'stub@1',
    capabilities: { streaming: true, editPolicy: 'verbatim' as never },
    async invokeOnce(): Promise<InvocationResult> {
      throw new Error('this scripted client only streams — invokeOnce should not be called')
    },
    stream(req: ProviderRequest, attempt: number) {
      requests.push(structuredClone({ ...req, signal: undefined }))
      const turn = queue.shift()
      if (!turn) throw new Error('script exhausted')
      n += 1
      async function* gen(): AsyncGenerator<ProviderStreamEvent> {
        yield { type: 'started' }
        for (const t of turn!.deltas ?? []) yield { type: 'text-delta', index: 0, text: t }
        const result: InvocationResult = {
          invocationId: req.correlation.invocationId, attempt, provider: 'anthropic', requestedModel: req.model,
          startedAt: '2026-09-27T12:00:00.000Z', latencyMs: 5, status: 'completed', messageId: `msg_${n}`,
          servedModel: req.model, usage: fromAnthropicUsage({ input_tokens: 10, output_tokens: 5 }).usage,
          usageAnomalies: [], content: turn!.content,
          stopReason: fromAnthropicStopReason(turn!.content.some(c => c.type === 'tool_use') ? 'tool_use' : 'end_turn'),
        }
        yield { type: 'end', result }
      }
      return gen()
    },
  }
}

const use = (id: string, name: string, input: unknown): ProviderContent => ({ type: 'tool_use', id, name, input })

let ws: string

beforeAll(async () => {
  ws = await realpath(await mkdtemp(join(tmpdir(), 'agt-code-ws-')))
  await writeFile(join(ws, 'hello.ts'), "export const greeting = 'hello'\n")
  const git = (...a: string[]) => Bun.spawnSync(['git', '-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: ws, env: gitTestEnv() })
  git('init', '-q'); git('add', '.'); git('commit', '-qm', 'init')
})

afterAll(async () => {
  await rm(ws, { recursive: true, force: true })
})

let dbDir: string

beforeEach(async () => {
  dbDir = await mkdtemp(join(tmpdir(), 'agt-code-db-'))
})

afterEach(async () => {
  await rm(dbDir, { recursive: true, force: true })
})

/** Builds a `CodeHostFactory` over this test's temp store/content, a scripted client, and an
 *  optional array journal recorder (default: events are dropped, same as `journal: null`). */
function makeHostFactory(opts: {
  client: ProviderClient
  journalEvents?: AgentisticsEvent[]
}): CodeHostFactory {
  return async (askerFor) => {
    const events = opts.journalEvents
    const journal: ProviderJournalSink = {
      async append(batch) {
        if (events) events.push(...batch)
        return { written: batch.length, duplicates: 0 }
      },
    }
    const dataDir = await mkdtemp(join(tmpdir(), 'agt-code-home-'))
    const host = await createRuntimeHost({
      dbPath: join(dbDir, 'sessions.db'),
      contentDir: join(dbDir, 'content'),
      home: dataDir,
      journal,
      clientFor: () => opts.client,
      askerFor,
    })
    const content = createFileContentStore(join(dbDir, 'content'))
    return { host, content, journal, runtimeVersion: 'agentistics-runtime@b4-test' }
  }
}

function scriptedReadLine(lines: string[]): () => Promise<string | null> {
  const queue = [...lines]
  return async () => (queue.length > 0 ? (queue.shift() as string) : null)
}

function makeDeps(overrides: Partial<CodeCliDeps>): { deps: Partial<CodeCliDeps>; out: string[] } {
  const out: string[] = []
  const deps: Partial<CodeCliDeps> = {
    stdout: (line) => out.push(`${line}\n`),
    stderr: (line) => out.push(`!${line}\n`),
    write: (chunk) => out.push(chunk),
    isTty: true,
    cwd: ws,
    now: () => new Date('2026-09-28T00:00:00.000Z'),
    readLine: scriptedReadLine([]),
    askTimeoutMs: 5000,
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (h) => clearTimeout(h),
    onInterrupt: () => () => {},
    flagOn: () => true,
    ...overrides,
  }
  return { deps, out }
}

describe('agentop code — new session', () => {
  test('prints the no-sandbox line, the session id, and streams the answer', async () => {
    const client = scriptedStreamingClient([{ content: [{ type: 'text', text: 'hello there' }], deltas: ['hello ', 'there'] }])
    const host = makeHostFactory({ client })
    const { deps, out } = makeDeps({ host })

    const code = await runCode(['--model', 'claude-test', 'say hi'], deps)

    expect(code).toBe(0)
    const joined = out.join('')
    expect(joined).toContain('no sandbox: tools run as you, in ' + ws)
    expect(joined).toMatch(/session ses_[0-9a-f]+ /)
    expect(joined).toContain('hello there')
  })

  test('requires --model when there is no default', async () => {
    const client = scriptedStreamingClient([])
    const host = makeHostFactory({ client })
    const { deps, out } = makeDeps({ host })

    const code = await runCode(['say hi'], deps)

    expect(code).toBe(2)
    expect(out.join('')).toContain('--model')
  })
})

describe('agentop code — approval', () => {
  test('an approved tool call runs; a second, unanswered one is denied and the model is told', async () => {
    const patch1 = [
      '*** Begin Patch', '*** Update File: hello.ts', '@@',
      "-export const greeting = 'hello'", "+export const greeting = 'hello, world'",
      '*** End Patch',
    ].join('\n')
    const patch2 = [
      '*** Begin Patch', '*** Update File: hello.ts', '@@',
      "-export const greeting = 'hello, world'", "+export const greeting = 'hello, denied'",
      '*** End Patch',
    ].join('\n')

    const client = scriptedStreamingClient([
      // `file.patch` refuses `stale` unless the model read the file first (patch.ts's own
      // read-before-write ledger) — a real model always reads before it patches.
      { content: [use('r1', 'file__read', { path: 'hello.ts' })] },
      { content: [use('t1', 'file__patch', { patch: patch1 })] },
      { content: [use('r2', 'file__read', { path: 'hello.ts' })] },
      { content: [use('t2', 'file__patch', { patch: patch2 })] },
      { content: [{ type: 'text', text: 'done' }], deltas: ['done'] },
    ])
    const host = makeHostFactory({ client })
    // "1" answers the first ask (Allow once); every later readLine (the second ask, then the
    // interactive loop's next prompt) is EOF.
    const { deps, out } = makeDeps({ host, readLine: scriptedReadLine(['1']) })

    const code = await runCode(['--model', 'claude-test', 'patch the greeting'], deps)

    expect(code).toBe(0)
    const joined = out.join('')
    expect(joined).toContain('✓ file.patch')
    expect(joined).toContain('✗ file.patch (denied)')
    expect(joined).toContain('done')

    // The approved patch really landed; the denied one never touched the file.
    expect(await readFile(join(ws, 'hello.ts'), 'utf8')).toBe("export const greeting = 'hello, world'\n")

    // The model was told the second call was denied, in words, as an error.
    const resultOf = (id: string) => client.requests
      .flatMap(q => q.messages)
      .flatMap(m => (typeof m.content === 'string' ? [] : m.content))
      .find((p): p is Extract<typeof p, { type: 'tool_result' }> => p.type === 'tool_result' && p.toolUseId === id)
    const denied = resultOf('t2')
    expect(denied?.isError).toBe(true)
    expect(denied?.content).toContain('No person was available')
  })
})

describe('agentop code ls', () => {
  test('lists a session that was started', async () => {
    const client = scriptedStreamingClient([{ content: [{ type: 'text', text: 'hi' }], deltas: ['hi'] }])
    const host = makeHostFactory({ client })
    const { deps: createDeps } = makeDeps({ host })
    await runCode(['--model', 'claude-test', 'hi'], createDeps)

    const { deps: lsDeps, out } = makeDeps({ host })
    const code = await runCode(['ls'], lsDeps)

    expect(code).toBe(0)
    expect(out.join('')).toMatch(/ses_[0-9a-f]+\s+open\s+/)
  })

  test('says so when there are no sessions yet', async () => {
    const client = scriptedStreamingClient([])
    const host = makeHostFactory({ client })
    const { deps, out } = makeDeps({ host })

    const code = await runCode(['ls'], deps)

    expect(code).toBe(0)
    expect(out.join('')).toContain('No native sessions yet');
  })
})

describe('agentop code --resume', () => {
  async function seedSession(status: SessionRecord['status'] = 'open'): Promise<string> {
    const store: SessionStore = openSqliteSessionStore(join(dbDir, 'sessions.db'))
    const sessionId = `ses_${'a'.repeat(32)}`
    const session: SessionRecord = {
      sessionId, createdAt: '2026-09-27T12:00:00.000Z', updatedAt: '2026-09-27T12:00:00.000Z',
      status, workspaceRoot: ws, cwd: ws, provider: 'anthropic', model: 'claude-test',
      credential: { provider: 'anthropic', id: 'default' }, messageCount: 0, lastSeq: 0, runCount: 1,
    }
    await store.createSession(session)
    await store.createRun({
      runId: 'run_dead00000000000000000000000', sessionId,
      startedAt: '2026-09-27T12:00:00.000Z', status: 'running', turns: 1, toolCalls: 0,
    })
    store.close()
    return sessionId
  }

  test('repairs a run a killed process left running, then continues', async () => {
    const sessionId = await seedSession()
    const journalEvents: AgentisticsEvent[] = []
    const client = scriptedStreamingClient([{ content: [{ type: 'text', text: 'continuing' }], deltas: ['continuing'] }])
    const host = makeHostFactory({ client, journalEvents })
    const { deps, out } = makeDeps({ host, readLine: scriptedReadLine([]) })

    const code = await runCode(['--resume', sessionId, 'keep going'], deps)

    expect(code).toBe(0)
    const joined = out.join('')
    expect(joined).toContain(`Repaired run run_dead00000000000000000000000`)
    expect(joined).toContain('no sandbox: tools run as you')
    expect(joined).toContain('continuing')
    expect(journalEvents.some(e => e.type === 'run.ended')).toBe(true)
  })

  test('refuses when the lease is held by another live process', async () => {
    const sessionId = await seedSession()
    const store: SessionStore = openSqliteSessionStore(join(dbDir, 'sessions.db'))
    // A REALLY live process: the host probes the pid (`pidAlive`), so an invented pid reads as dead.
    const other = Bun.spawn(['sleep', '30'])
    await store.acquireLease(sessionId, { pid: other.pid, token: 'someone-else' }, 60_000)
    store.close()

    const client = scriptedStreamingClient([])
    const host = makeHostFactory({ client })
    const { deps, out } = makeDeps({ host })

    const code = await runCode(['--resume', sessionId], deps)

    other.kill()
    expect(code).toBe(1)
    expect(out.join('')).toContain(`already being driven by pid ${other.pid}`)
  })

  test('reports no such session', async () => {
    const client = scriptedStreamingClient([])
    const host = makeHostFactory({ client })
    const { deps, out } = makeDeps({ host })

    const code = await runCode(['--resume', 'ses_doesnotexist00000000000000000'], deps)

    expect(code).toBe(1)
    expect(out.join('')).toContain('No such session');
  })
})

describe('agentop code — the BETA flag', () => {
  test('refuses before creating anything when AGENTISTICS_PROVIDER is off', async () => {
    let built = false
    const { deps, out } = makeDeps({ flagOn: () => false, host: async () => { built = true; throw new Error('no host expected') } })
    expect(await runCode(['--model', 'm', 'hi'], deps)).toBe(1)
    expect(built).toBe(false)
    expect(out.join('')).toContain('AGENTISTICS_PROVIDER=1')
  })
})
