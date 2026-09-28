/**
 * runtime-sessions-web.test.ts — B4.3: the `/api/runtime/*` session routes over a REAL
 * `RuntimeHost` (real sqlite store, real file content store, real native tools/policy), driven by a
 * scripted `ProviderClient` — the same offline shape `loop/e2e.test.ts` and `runtime.test.ts` use.
 * `journal: null` throughout, per the build note.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  classifyProviderError,
  fromAnthropicStopReason,
  fromAnthropicUsage,
  type ProviderId,
} from '@agentistics/core'
import {
  createFileContentStore,
  type InvocationResult,
  type ProviderClient,
  type ProviderContent,
  type ProviderRequest,
} from '@agentistics/runtime'
import { createRuntimeHost, type RuntimeHost } from './runtime-host'
import {
  _resetRuntimeSessionsWebState,
  handleRuntimeSessionsRequest,
  matchRuntimeSessionsRoute,
  parseApproveBody,
  parseCreateSessionBody,
  parseSendMessageBody,
  type RuntimeSessionsBundle,
  type RuntimeSessionsWebDeps,
} from './runtime-sessions-web'

// ── scripted providers ─────────────────────────────────────────────────────────────────────────

const use = (id: string, name: string, input: unknown): ProviderContent => ({ type: 'tool_use', id, name, input })

function scriptedClient(turns: ProviderContent[][], counter?: { n: number }): ProviderClient {
  let n = 0
  return {
    provider: 'anthropic',
    adapterVersion: 'stub@1',
    capabilities: { streaming: false, editPolicy: 'verbatim' as never },
    async invokeOnce(req, attempt): Promise<InvocationResult> {
      const content = turns.shift()
      if (!content) throw new Error('script exhausted')
      n += 1
      if (counter) counter.n = n
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

/** A client whose one attempt hangs until the caller's signal aborts — for the cancel test. */
function hangingClient(): ProviderClient {
  return {
    provider: 'anthropic',
    adapterVersion: 'stub@1',
    capabilities: { streaming: false, editPolicy: 'verbatim' as never },
    async invokeOnce(req: ProviderRequest, attempt): Promise<InvocationResult> {
      return await new Promise<InvocationResult>(resolve => {
        const timer = setTimeout(() => resolve({
          invocationId: req.correlation.invocationId, attempt, provider: 'anthropic', requestedModel: req.model,
          startedAt: '2026-09-27T12:00:00.000Z', latencyMs: 5000, status: 'completed', messageId: 'msg_late',
          servedModel: req.model, usage: fromAnthropicUsage({ input_tokens: 1, output_tokens: 1 }).usage,
          usageAnomalies: [], content: [{ type: 'text', text: 'too late' }], stopReason: fromAnthropicStopReason('end_turn'),
        }), 5000)
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

// ── harness ─────────────────────────────────────────────────────────────────────────────────────

const roots: string[] = []
const hosts: RuntimeHost[] = []

async function tempRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'agt-b4-web-'))
  roots.push(dir)
  return dir
}

async function makeBundle(opts: {
  dbPath: string
  contentDir: string
  pid?: number
  isAlive?: (pid: number) => boolean
  clientFor?: (p: ProviderId) => ProviderClient
}): Promise<RuntimeSessionsBundle> {
  const host = await createRuntimeHost({
    dbPath: opts.dbPath,
    contentDir: opts.contentDir,
    journal: null,
    clientFor: opts.clientFor ?? (() => scriptedClient([[{ type: 'text', text: 'ok' }]])),
    pid: opts.pid ?? process.pid,
    isAlive: opts.isAlive ?? (() => true),
    runtimeVersion: 'runtime@b4-web-test',
  })
  hosts.push(host)
  const content = createFileContentStore(opts.contentDir)
  return { host, resume: { store: host.store, content, journal: null, runtimeVersion: 'runtime@b4-web-test' } }
}

function depsFor(bundle: RuntimeSessionsBundle, opts: { central?: boolean; driven?: Set<string>; flagOn?: boolean } = {}): Partial<RuntimeSessionsWebDeps> {
  return {
    isCentral: async () => opts.central ?? false,
    flagOn: () => opts.flagOn ?? true,
    host: async () => bundle,
    readSpawnBudget: async () => null, // unmeasured: admits unconditionally
    driven: opts.driven ?? new Set<string>(),
  }
}

function req(url: string, init: RequestInit = {}): Request {
  return new Request(`http://localhost${url}`, init)
}

function jsonReq(url: string, body: unknown, init: RequestInit = {}): Request {
  return req(url, { method: 'POST', body: JSON.stringify(body), ...init })
}

async function jsonOf(out: Awaited<ReturnType<typeof handleRuntimeSessionsRequest>>): Promise<{ status: number; body: unknown }> {
  if (!out || out.kind !== 'json') throw new Error(`expected a json result, got ${out?.kind ?? 'null'}`)
  return { status: out.status, body: out.body }
}

/**
 * ONE reader per SSE stream, reused across several `readUntil` calls — a `ReadableStream` can only
 * ever be locked by one reader at a time, so collecting "up to the ask" and later "up to run.ended"
 * on the SAME stream must share one reader and one accumulated frame list, never a fresh
 * `getReader()` per wait.
 */
function frameReader(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader()
  const dec = new TextDecoder()
  let buf = ''
  const frames: Record<string, unknown>[] = []

  async function pump(): Promise<boolean> {
    const { done, value } = await reader.read()
    if (done) return false
    buf += dec.decode(value, { stream: true })
    let idx: number
    while ((idx = buf.indexOf('\n\n')) !== -1) {
      const chunk = buf.slice(0, idx)
      buf = buf.slice(idx + 2)
      if (chunk.startsWith('data: ')) frames.push(JSON.parse(chunk.slice(6)))
    }
    return true
  }

  return {
    /** Every frame read on this stream so far (across every `readUntil` call), until `until` holds. */
    async readUntil(until: (fs: Record<string, unknown>[]) => boolean, timeoutMs = 8000): Promise<Record<string, unknown>[]> {
      const deadline = Date.now() + timeoutMs
      while (!until(frames)) {
        if (Date.now() >= deadline) throw new Error(`frameReader: timed out with ${frames.length} frame(s): ${JSON.stringify(frames)}`)
        if (!(await pump())) throw new Error(`frameReader: stream ended with ${frames.length} frame(s): ${JSON.stringify(frames)}`)
      }
      return [...frames]
    },
    async close(): Promise<void> {
      await reader.cancel().catch(() => {})
    },
  }
}

async function waitFor<T>(fn: () => Promise<T | null | undefined>, timeoutMs = 8000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const v = await fn()
    if (v !== null && v !== undefined) return v
    await new Promise(r => setTimeout(r, 20))
  }
  throw new Error('waitFor: timed out')
}

afterEach(async () => {
  _resetRuntimeSessionsWebState()
  await Promise.all(hosts.splice(0).map(h => h.dispose()))
  await Promise.all(roots.splice(0).map(d => rm(d, { recursive: true, force: true })))
})

// ── pure route/body parsing ─────────────────────────────────────────────────────────────────────

describe('matchRuntimeSessionsRoute', () => {
  test('the five §28 resources', () => {
    expect(matchRuntimeSessionsRoute('/api/runtime/sessions')).toEqual({ kind: 'sessions' })
    expect(matchRuntimeSessionsRoute('/api/runtime/sessions/ses_1')).toEqual({ kind: 'session', id: 'ses_1' })
    expect(matchRuntimeSessionsRoute('/api/runtime/sessions/ses_1/messages')).toEqual({ kind: 'messages', id: 'ses_1' })
    expect(matchRuntimeSessionsRoute('/api/runtime/sessions/ses_1/stream')).toEqual({ kind: 'stream', id: 'ses_1' })
    expect(matchRuntimeSessionsRoute('/api/runtime/tools/tx_1/approve')).toEqual({ kind: 'approve', execId: 'tx_1' })
    expect(matchRuntimeSessionsRoute('/api/runtime/runs/run_1/cancel')).toEqual({ kind: 'cancel', id: 'run_1' })
  })
  test('a session id can never be read as a sub-resource word', () => {
    expect(matchRuntimeSessionsRoute('/api/runtime/sessions/messages')).toEqual({ kind: 'session', id: 'messages' })
  })
  test('unrelated paths are null', () => {
    expect(matchRuntimeSessionsRoute('/api/runtime/metrics')).toBeNull()
    expect(matchRuntimeSessionsRoute('/api/runtime/sessions/ses_1/messages/extra')).toBeNull()
  })
})

describe('parseCreateSessionBody', () => {
  test('requires an absolute cwd', () => {
    const out = parseCreateSessionBody({ cwd: 'relative/path', model: 'claude-x' })
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.error).toBe('cwd_relative')
  })
  test('requires a model', () => {
    const out = parseCreateSessionBody({ cwd: '/tmp/x' })
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.error).toBe('model_required')
  })
  test('a well-formed body', () => {
    const out = parseCreateSessionBody({ cwd: '/tmp/x', model: 'claude-x', title: 't' })
    expect(out).toEqual({ ok: true, body: { cwd: '/tmp/x', model: 'claude-x', title: 't' } })
  })
})

describe('parseSendMessageBody', () => {
  test('requires clientRef and text', () => {
    expect(parseSendMessageBody({}).ok).toBe(false)
    expect(parseSendMessageBody({ clientRef: 'c1' }).ok).toBe(false)
    expect(parseSendMessageBody({ clientRef: 'c1', text: '' }).ok).toBe(false)
  })
  test('a well-formed body', () => {
    expect(parseSendMessageBody({ clientRef: 'c1', text: 'hi' })).toEqual({ ok: true, body: { clientRef: 'c1', text: 'hi' } })
  })
})

describe('parseApproveBody', () => {
  test('requires sessionId and questionId', () => {
    expect(parseApproveBody({}).ok).toBe(false)
    expect(parseApproveBody({ sessionId: 's' }).ok).toBe(false)
  })
  test('accepts an optional choice/text', () => {
    expect(parseApproveBody({ sessionId: 's', questionId: 'q', choice: 0 })).toEqual({ ok: true, body: { sessionId: 's', questionId: 'q', choice: 0 } })
  })
})

// ── the routes, over a real host ───────────────────────────────────────────────────────────────

describe('POST /api/runtime/sessions', () => {
  test('refuses on a central', async () => {
    const root = await tempRoot()
    const bundle = await makeBundle({ dbPath: join(root, 'sessions.db'), contentDir: join(root, 'content') })
    const out = await handleRuntimeSessionsRequest(
      jsonReq('/api/runtime/sessions', { cwd: root, model: 'claude-x' }),
      new URL('http://localhost/api/runtime/sessions'),
      depsFor(bundle, { central: true }),
    )
    const { status, body } = await jsonOf(out)
    expect(status).toBe(403)
    expect((body as { code: string }).code).toBe('central')
  })

  test('refuses every route while the BETA flag is off, before any session exists', async () => {
    const root = await tempRoot()
    const bundle = await makeBundle({ dbPath: join(root, 'sessions.db'), contentDir: join(root, 'content') })
    const out = await handleRuntimeSessionsRequest(
      jsonReq('/api/runtime/sessions', { cwd: root, model: 'claude-x' }),
      new URL('http://localhost/api/runtime/sessions'),
      depsFor(bundle, { flagOn: false }),
    )
    const { status, body } = await jsonOf(out)
    expect(status).toBe(409)
    expect((body as { code: string }).code).toBe('flag-off')
    expect((await bundle.host.store.listSessions({ limit: 10 })).sessions).toHaveLength(0)
  })

  test('refuses a relative cwd with 400', async () => {
    const root = await tempRoot()
    const bundle = await makeBundle({ dbPath: join(root, 'sessions.db'), contentDir: join(root, 'content') })
    const out = await handleRuntimeSessionsRequest(
      jsonReq('/api/runtime/sessions', { cwd: 'relative/dir', model: 'claude-x' }),
      new URL('http://localhost/api/runtime/sessions'),
      depsFor(bundle),
    )
    const { status, body } = await jsonOf(out)
    expect(status).toBe(400)
    expect((body as { code: string }).code).toBe('cwd_relative')
  })

  test('refuses a missing cwd with 400', async () => {
    const root = await tempRoot()
    const bundle = await makeBundle({ dbPath: join(root, 'sessions.db'), contentDir: join(root, 'content') })
    const out = await handleRuntimeSessionsRequest(
      jsonReq('/api/runtime/sessions', { cwd: join(root, 'does-not-exist'), model: 'claude-x' }),
      new URL('http://localhost/api/runtime/sessions'),
      depsFor(bundle),
    )
    const { status, body } = await jsonOf(out)
    expect(status).toBe(400)
    expect((body as { code: string }).code).toBe('cwd_missing')
  })

  test('creates a session', async () => {
    const root = await tempRoot()
    const bundle = await makeBundle({ dbPath: join(root, 'sessions.db'), contentDir: join(root, 'content') })
    const out = await handleRuntimeSessionsRequest(
      jsonReq('/api/runtime/sessions', { cwd: root, model: 'claude-x', title: 'hello' }),
      new URL('http://localhost/api/runtime/sessions'),
      depsFor(bundle),
    )
    const { status, body } = await jsonOf(out)
    expect(status).toBe(201)
    const session = (body as { session: { sessionId: string; status: string; model: string; title?: string } }).session
    expect(session.sessionId).toMatch(/^ses_[0-9a-f]{32}$/)
    expect(session.status).toBe('open')
    expect(session.model).toBe('claude-x')
    expect(session.title).toBe('hello')
  })
})

describe('unknown ids answer 404', () => {
  test('GET session / messages / stream', async () => {
    const root = await tempRoot()
    const bundle = await makeBundle({ dbPath: join(root, 'sessions.db'), contentDir: join(root, 'content') })
    const d = depsFor(bundle)

    const get = await jsonOf(await handleRuntimeSessionsRequest(
      req('/api/runtime/sessions/ses_nope'), new URL('http://localhost/api/runtime/sessions/ses_nope'), d,
    ))
    expect(get.status).toBe(404)

    const msgs = await jsonOf(await handleRuntimeSessionsRequest(
      req('/api/runtime/sessions/ses_nope/messages'), new URL('http://localhost/api/runtime/sessions/ses_nope/messages'), d,
    ))
    expect(msgs.status).toBe(404)

    const streamOut = await handleRuntimeSessionsRequest(
      req('/api/runtime/sessions/ses_nope/stream'), new URL('http://localhost/api/runtime/sessions/ses_nope/stream'), d,
    )
    expect(streamOut?.kind).toBe('json')
    if (streamOut?.kind === 'json') expect(streamOut.status).toBe(404)
  })
})

describe('the shared session: two watchers, one run, an ask both can see', () => {
  test('identical seq-ordered frames, exactly one run, approve resolves the ask and a second approve is refused', async () => {
    const root = await tempRoot()
    const counter = { n: 0 }
    const bundle = await makeBundle({
      dbPath: join(root, 'sessions.db'),
      contentDir: join(root, 'content'),
      // `cat` is not a SAFE_BUILTINS verb (unlike `echo`), so the floor policy asks a person —
      // see `policy.ts`'s `SAFE_BUILTINS` check. The target need not exist: the policy decision is
      // about the command, not its outcome, and a "file not found" result is still a normal
      // `tool.completed` that ends the run.
      clientFor: () => scriptedClient([
        [use('t1', 'shell__start', { command: 'cat nope.txt' })],
        [{ type: 'text', text: 'done' }],
      ], counter),
    })
    const d = depsFor(bundle)

    const created = await jsonOf(await handleRuntimeSessionsRequest(
      jsonReq('/api/runtime/sessions', { cwd: root, model: 'claude-x' }),
      new URL('http://localhost/api/runtime/sessions'), d,
    ))
    expect(created.status).toBe(201)
    const sessionId = (created.body as { session: { sessionId: string } }).session.sessionId

    // Both watchers attach BEFORE the send, so both see the same frames from the live edge on.
    const stream1Out = await handleRuntimeSessionsRequest(
      req(`/api/runtime/sessions/${sessionId}/stream`), new URL(`http://localhost/api/runtime/sessions/${sessionId}/stream`), d,
    )
    const stream2Out = await handleRuntimeSessionsRequest(
      req(`/api/runtime/sessions/${sessionId}/stream`), new URL(`http://localhost/api/runtime/sessions/${sessionId}/stream`), d,
    )
    if (stream1Out?.kind !== 'stream' || stream2Out?.kind !== 'stream') throw new Error('expected two streams')

    const sent = await jsonOf(await handleRuntimeSessionsRequest(
      jsonReq(`/api/runtime/sessions/${sessionId}/messages`, { clientRef: 'c1', text: 'go' }),
      new URL(`http://localhost/api/runtime/sessions/${sessionId}/messages`), d,
    ))
    expect(sent.status).toBe(202)
    expect((sent.body as { status: string }).status).toBe('queued')

    const r1 = frameReader(stream1Out.stream)
    const r2 = frameReader(stream2Out.stream)
    const hasAsk = (fs: Record<string, unknown>[]) => fs.some(f => f.kind === 'ask')
    const [framesUpToAsk1, framesUpToAsk2] = await Promise.all([r1.readUntil(hasAsk), r2.readUntil(hasAsk)])
    const ask1 = framesUpToAsk1.find(f => f.kind === 'ask') as { question: { id: string } }
    const ask2 = framesUpToAsk2.find(f => f.kind === 'ask') as { question: { id: string } }
    expect(ask1.question.id).toBe(ask2.question.id)
    const questionId = ask1.question.id
    const execId = questionId.replace(/:permission$/, '')
    expect(questionId.startsWith(execId)).toBe(true)

    const approved = await jsonOf(await handleRuntimeSessionsRequest(
      jsonReq(`/api/runtime/tools/${execId}/approve`, { sessionId, questionId, choice: 0 }),
      new URL(`http://localhost/api/runtime/tools/${execId}/approve`), d,
    ))
    expect(approved).toEqual({ status: 200, body: { accepted: true } })

    const approvedAgain = await jsonOf(await handleRuntimeSessionsRequest(
      jsonReq(`/api/runtime/tools/${execId}/approve`, { sessionId, questionId, choice: 0 }),
      new URL(`http://localhost/api/runtime/tools/${execId}/approve`), d,
    ))
    expect(approvedAgain.status).toBe(409)
    expect((approvedAgain.body as { accepted: boolean }).accepted).toBe(false)

    const isRunEnded = (fs: Record<string, unknown>[]) =>
      fs.some(f => f.kind === 'event' && (f.event as { type: string }).type === 'run.ended')
    const [allFrames1, allFrames2] = await Promise.all([r1.readUntil(isRunEnded), r2.readUntil(isRunEnded)])
    expect(allFrames1).toEqual(allFrames2)
    await Promise.all([r1.close(), r2.close()])

    // Two provider turns (the tool call, then the final text) — one run, not two.
    expect(counter.n).toBe(2)
    const session = await bundle.host.runtime.get(sessionId)
    expect(session?.runCount).toBe(1)
  }, 15000)
})

describe('POST /api/runtime/sessions/:id/messages — the lease', () => {
  test('a lease held by another live pid is refused with 409', async () => {
    const root = await tempRoot()
    const dbPath = join(root, 'sessions.db')
    const contentDir = join(root, 'content')
    const bundleA = await makeBundle({ dbPath, contentDir, pid: 11111, isAlive: () => true })
    const bundleB = await makeBundle({ dbPath, contentDir, pid: 22222, isAlive: () => true })

    const created = await jsonOf(await handleRuntimeSessionsRequest(
      jsonReq('/api/runtime/sessions', { cwd: root, model: 'claude-x' }),
      new URL('http://localhost/api/runtime/sessions'), depsFor(bundleA),
    ))
    const sessionId = (created.body as { session: { sessionId: string } }).session.sessionId

    const firstSend = await jsonOf(await handleRuntimeSessionsRequest(
      jsonReq(`/api/runtime/sessions/${sessionId}/messages`, { clientRef: 'c1', text: 'hi' }),
      new URL(`http://localhost/api/runtime/sessions/${sessionId}/messages`), depsFor(bundleA),
    ))
    expect(firstSend.status).toBe(202)

    const secondSend = await jsonOf(await handleRuntimeSessionsRequest(
      jsonReq(`/api/runtime/sessions/${sessionId}/messages`, { clientRef: 'c2', text: 'hi again' }),
      new URL(`http://localhost/api/runtime/sessions/${sessionId}/messages`), depsFor(bundleB),
    ))
    expect(secondSend.status).toBe(409)
    expect((secondSend.body as { code: string }).code).toBe('held')

    // Let bundleA's background run settle before teardown disposes its host.
    await waitFor(async () => {
      const s = await bundleA.host.runtime.get(sessionId)
      return s && s.runCount > 0 ? s : null
    })
  })
})

describe('POST /api/runtime/runs/:id/cancel', () => {
  test('ends a running run as abandoned', async () => {
    const root = await tempRoot()
    const bundle = await makeBundle({
      dbPath: join(root, 'sessions.db'),
      contentDir: join(root, 'content'),
      clientFor: () => hangingClient(),
    })
    const d = depsFor(bundle)

    const created = await jsonOf(await handleRuntimeSessionsRequest(
      jsonReq('/api/runtime/sessions', { cwd: root, model: 'claude-x' }),
      new URL('http://localhost/api/runtime/sessions'), d,
    ))
    const sessionId = (created.body as { session: { sessionId: string } }).session.sessionId

    const sent = await jsonOf(await handleRuntimeSessionsRequest(
      jsonReq(`/api/runtime/sessions/${sessionId}/messages`, { clientRef: 'c1', text: 'hi' }),
      new URL(`http://localhost/api/runtime/sessions/${sessionId}/messages`), d,
    ))
    expect(sent.status).toBe(202)

    const run = await waitFor(() => bundle.host.store.latestRun(sessionId))
    expect(run.status).toBe('running')

    const cancelled = await jsonOf(await handleRuntimeSessionsRequest(
      req(`/api/runtime/runs/${run.runId}/cancel`, { method: 'POST' }),
      new URL(`http://localhost/api/runtime/runs/${run.runId}/cancel`), d,
    ))
    expect(cancelled).toEqual({ status: 200, body: { cancelled: true } })

    const settled = await waitFor(async () => {
      const r = await bundle.host.store.getRun(run.runId)
      return r && r.status !== 'running' ? r : null
    })
    expect(settled.status).toBe('abandoned')

    const cancelledAgain = await jsonOf(await handleRuntimeSessionsRequest(
      req(`/api/runtime/runs/${run.runId}/cancel`, { method: 'POST' }),
      new URL(`http://localhost/api/runtime/runs/${run.runId}/cancel`), d,
    ))
    expect(cancelledAgain).toEqual({ status: 200, body: { cancelled: false } })
  })
})
