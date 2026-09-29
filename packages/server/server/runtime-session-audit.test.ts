/**
 * runtime-session-audit.test.ts — H8: every act that creates or drives a NATIVE session writes an
 * audit line (who, what verb, which session, which surface) and none of them carries a prompt, a tool
 * input, a question's text, a free-text answer or a title. Driven over a REAL `RuntimeHost` (sqlite
 * store, file content store, real policy) with a scripted `ProviderClient`, like
 * `runtime-sessions-web.test.ts`. Nothing here touches `~/.agentistics`: every store and every log is
 * under a temp directory.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fromAnthropicStopReason, fromAnthropicUsage } from '@agentistics/core'
import {
  createFileContentStore,
  type InvocationResult,
  type ProviderClient,
  type ProviderContent,
} from '@agentistics/runtime'
import {
  _resetAuditFailures,
  appendAuditLine,
  auditFailureCount,
  buildRuntimeSessionAudit,
  RUNTIME_SESSION_ACTIONS,
  type AuditInput,
  type RuntimeSessionAct,
  type RuntimeSessionVerb,
} from './audit'
import { createRuntimeHost, createRuntimeSessionAuditor, type RuntimeAuditSink, type RuntimeHost } from './runtime-host'
import {
  _resetRuntimeSessionsWebState,
  handleRuntimeSessionsRequest,
  type RuntimeSessionsBundle,
  type RuntimeSessionsWebDeps,
} from './runtime-sessions-web'

/** Put into every prompt, tool input, title and free-text answer. It may NEVER reach an audit line. */
const SENTINEL = 'SENTINEL_h8_7f3a9c'

// ── harness ─────────────────────────────────────────────────────────────────────────────────────

const use = (id: string, name: string, input: unknown): ProviderContent => ({ type: 'tool_use', id, name, input })

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
        startedAt: '2026-09-29T12:00:00.000Z', latencyMs: 5, status: 'completed', messageId: `msg_${n}`,
        servedModel: req.model, usage: fromAnthropicUsage({ input_tokens: 10, output_tokens: 5 }).usage,
        usageAnomalies: [], content,
        stopReason: fromAnthropicStopReason(content.some(c => c.type === 'tool_use') ? 'tool_use' : 'end_turn'),
      }
    },
  }
}

const roots: string[] = []
const hosts: RuntimeHost[] = []

async function tempRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'agt-h8-audit-'))
  roots.push(dir)
  return dir
}

async function makeBundle(root: string, opts: {
  client?: ProviderClient
  sink?: RuntimeAuditSink
  pid?: number
}): Promise<RuntimeSessionsBundle> {
  const contentDir = join(root, 'content')
  const host = await createRuntimeHost({
    dbPath: join(root, 'sessions.db'),
    contentDir,
    journal: null,
    clientFor: () => opts.client ?? scriptedClient([[{ type: 'text', text: 'ok' }]]),
    pid: opts.pid ?? process.pid,
    isAlive: () => true,
    runtimeVersion: 'runtime@h8-test',
    actor: 'local:tester',
    ...(opts.sink ? { auditSink: opts.sink } : {}),
  })
  hosts.push(host)
  return { host, resume: { store: host.store, content: createFileContentStore(contentDir), journal: null, runtimeVersion: 'runtime@h8-test' } }
}

function depsFor(bundle: RuntimeSessionsBundle): Partial<RuntimeSessionsWebDeps> {
  return {
    isCentral: async () => false,
    flagOn: () => true,
    host: async () => bundle,
    readSpawnBudget: async () => null,
    driven: new Set<string>(),
    ip: '203.0.113.7',
  }
}

function call(url: string, d: Partial<RuntimeSessionsWebDeps>, init: RequestInit = {}) {
  return handleRuntimeSessionsRequest(new Request(`http://localhost${url}`, init), new URL(`http://localhost${url}`), d)
}

function post(url: string, body: unknown, d: Partial<RuntimeSessionsWebDeps>) {
  return call(url, d, { method: 'POST', body: JSON.stringify(body) })
}

async function jsonOf(out: Awaited<ReturnType<typeof handleRuntimeSessionsRequest>>): Promise<{ status: number; body: unknown }> {
  if (!out || out.kind !== 'json') throw new Error(`expected json, got ${out?.kind ?? 'null'}`)
  return { status: out.status, body: out.body }
}

async function waitFor<T>(fn: () => T | null | undefined | Promise<T | null | undefined>, timeoutMs = 8000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const v = await fn()
    if (v !== null && v !== undefined) return v
    await new Promise(r => setTimeout(r, 20))
  }
  throw new Error('waitFor: timed out')
}

function capture(): { lines: AuditInput[]; sink: RuntimeAuditSink } {
  const lines: AuditInput[] = []
  return { lines, sink: (input) => { lines.push(input); return true } }
}

afterEach(async () => {
  _resetRuntimeSessionsWebState()
  _resetAuditFailures()
  await Promise.all(hosts.splice(0).map(h => h.dispose()))
  await Promise.all(roots.splice(0).map(d => rm(d, { recursive: true, force: true })))
})

// ── the pure builder ────────────────────────────────────────────────────────────────────────────

describe('buildRuntimeSessionAudit', () => {
  const who = { actorId: 'local:tester', ip: '127.0.0.1' }

  test('every verb maps to its own additive action', () => {
    const verbs: RuntimeSessionVerb[] = ['approve', 'cancel', 'create', 'resume', 'send']
    expect(Object.keys(RUNTIME_SESSION_ACTIONS).sort()).toEqual(verbs)
    for (const verb of verbs) {
      const line = buildRuntimeSessionAudit({ verb, surface: 'web', sessionId: 'ses_1', outcome: 'ok' }, who)
      expect(line.action).toBe(`runtime.session.${verb}`)
      expect(line.targetId).toBe('ses_1')
      expect(line.actorId).toBe('local:tester')
      expect(line.meta).toEqual({ surface: 'web', outcome: 'ok' })
    }
  })

  test('meta is an ALLOWLIST: a field smuggled onto the act never reaches the line', () => {
    const act = {
      verb: 'send', surface: 'tui', sessionId: 'ses_1', outcome: 'ok',
      text: SENTINEL, prompt: SENTINEL, input: { command: SENTINEL }, title: SENTINEL, key: SENTINEL,
    } as unknown as RuntimeSessionAct
    const line = buildRuntimeSessionAudit(act, who)
    expect(JSON.stringify(line)).not.toContain(SENTINEL)
    expect(line.meta).toEqual({ surface: 'tui', outcome: 'ok' })
  })

  test('approve keeps the question id and the option index, never an out-of-range index', () => {
    const ok = buildRuntimeSessionAudit({ verb: 'approve', surface: 'cli', sessionId: 's', questionId: 'tx_1:permission', answer: 'choice', choice: 2, outcome: 'ok' }, who)
    expect(ok.meta).toEqual({ surface: 'cli', outcome: 'ok', questionId: 'tx_1:permission', answer: 'choice', choice: 2 })
    const bad = buildRuntimeSessionAudit({ verb: 'approve', surface: 'cli', sessionId: 's', answer: 'choice', choice: -1, outcome: 'ok' }, who)
    expect(bad.meta && 'choice' in bad.meta).toBe(false)
  })

  test('long identifiers are clipped', () => {
    const line = buildRuntimeSessionAudit({ verb: 'cancel', surface: 'web', runId: 'r'.repeat(1000), outcome: 'x'.repeat(1000) }, who)
    expect((line.meta!.runId as string).length).toBe(128)
    expect((line.meta!.outcome as string).length).toBe(128)
    expect(line.targetId).toBeUndefined()
  })
})

// ── the web routes ──────────────────────────────────────────────────────────────────────────────

describe('the /api/runtime/* routes audit every act, and no line carries content', () => {
  test('create, resume, send, approve (accepted and refused) and cancel — sentinel never appears', async () => {
    const root = await tempRoot()
    const { lines, sink } = capture()
    // `cat` is not a SAFE_BUILTINS verb, so the policy asks a person; the tool input carries the sentinel.
    const bundle = await makeBundle(root, {
      sink,
      client: scriptedClient([
        [use('t1', 'shell__start', { command: `cat ${SENTINEL}.txt` })],
        [{ type: 'text', text: `done ${SENTINEL}` }],
      ]),
    })
    const d = depsFor(bundle)

    const created = await jsonOf(await post('/api/runtime/sessions', { cwd: root, model: 'claude-x', title: SENTINEL }, d))
    expect(created.status).toBe(201)
    const sessionId = (created.body as { session: { sessionId: string } }).session.sessionId

    const stream = await call(`/api/runtime/sessions/${sessionId}/stream`, d)
    if (stream?.kind !== 'stream') throw new Error('expected a stream')
    const reader = stream.stream.getReader()
    const dec = new TextDecoder()
    let buf = ''

    const sent = await jsonOf(await post(`/api/runtime/sessions/${sessionId}/messages`, { clientRef: `${SENTINEL}-ref`, text: `please ${SENTINEL}` }, d))
    expect(sent.status).toBe(202)

    let questionId = ''
    while (questionId === '') {
      const { done, value } = await reader.read()
      if (done) throw new Error('stream ended before the ask')
      buf += dec.decode(value, { stream: true })
      let idx: number
      while ((idx = buf.indexOf('\n\n')) !== -1) {
        const chunk = buf.slice(0, idx)
        buf = buf.slice(idx + 2)
        if (!chunk.startsWith('data: ')) continue
        const frame = JSON.parse(chunk.slice(6)) as { kind: string; question?: { id: string } }
        if (frame.kind === 'ask' && frame.question) questionId = frame.question.id
      }
    }
    await reader.cancel().catch(() => {})
    const execId = questionId.replace(/:permission$/, '')

    const approved = await jsonOf(await post(`/api/runtime/tools/${execId}/approve`, { sessionId, questionId, choice: 0 }, d))
    expect(approved.status).toBe(200)
    const again = await jsonOf(await post(`/api/runtime/tools/${execId}/approve`, { sessionId, questionId, text: `free ${SENTINEL}` }, d))
    expect(again.status).toBe(409)

    await waitFor(async () => {
      const r = await bundle.host.store.latestRun(sessionId)
      return r && r.status !== 'running' ? r : null
    })
    const cancelled = await jsonOf(await call('/api/runtime/runs/run_unknown/cancel', d, { method: 'POST' }))
    expect(cancelled.body).toEqual({ cancelled: false })

    await bundle.host.dispose()
    hosts.splice(hosts.indexOf(bundle.host), 1)

    const serialized = JSON.stringify(lines)
    expect(serialized).not.toContain(SENTINEL)

    expect(lines.map(l => [l.action, l.meta!.outcome])).toEqual([
      ['runtime.session.create', 'ok'],
      ['runtime.session.resume', 'ok'],
      ['runtime.session.send', 'ok'],
      ['runtime.session.approve', 'ok'],
      ['runtime.session.approve', 'no_such_question'],
      ['runtime.session.cancel', 'not_running'],
    ])
    for (const l of lines) {
      expect(l.actorId).toBe('local:tester')
      expect(l.ip).toBe('203.0.113.7')
      expect(l.meta!.surface).toBe('web')
    }
    expect(lines.slice(0, 5).every(l => l.targetId === sessionId)).toBe(true)
    expect(lines[0]!.meta!.model).toBe('claude-x')
    expect(lines[1]!.meta!.repaired).toBe(false)
    expect(lines[3]!.meta).toMatchObject({ questionId, answer: 'choice', choice: 0 })
    expect(lines[4]!.meta!.answer).toBe('text')
    expect(lines[5]!.targetId).toBeUndefined()
    expect(lines[5]!.meta!.runId).toBe('run_unknown')
  }, 15000)

  test('a send refused because another process holds the session is audited as a held resume', async () => {
    const root = await tempRoot()
    const a = capture()
    const b = capture()
    const bundleA = await makeBundle(root, { sink: a.sink, pid: 11111 })
    const bundleB = await makeBundle(root, { sink: b.sink, pid: 22222 })

    const created = await jsonOf(await post('/api/runtime/sessions', { cwd: root, model: 'claude-x' }, depsFor(bundleA)))
    const sessionId = (created.body as { session: { sessionId: string } }).session.sessionId
    expect((await jsonOf(await post(`/api/runtime/sessions/${sessionId}/messages`, { clientRef: 'c1', text: SENTINEL }, depsFor(bundleA)))).status).toBe(202)
    expect((await jsonOf(await post(`/api/runtime/sessions/${sessionId}/messages`, { clientRef: 'c2', text: SENTINEL }, depsFor(bundleB)))).status).toBe(409)

    await waitFor(async () => {
      const s = await bundleA.host.runtime.get(sessionId)
      return s && s.runCount > 0 ? s : null
    })
    await Promise.all([bundleA.host.dispose(), bundleB.host.dispose()])
    hosts.splice(0)

    expect(b.lines.map(l => [l.action, l.targetId, l.meta!.outcome])).toEqual([['runtime.session.resume', sessionId, 'held']])
    expect(JSON.stringify([...a.lines, ...b.lines])).not.toContain(SENTINEL)
  })

  test('a sink that throws never fails the act — and the loss is counted', async () => {
    const root = await tempRoot()
    const bundle = await makeBundle(root, { sink: () => { throw new Error('audit store down') } })
    const d = depsFor(bundle)
    const before = auditFailureCount()

    const created = await jsonOf(await post('/api/runtime/sessions', { cwd: root, model: 'claude-x' }, d))
    expect(created.status).toBe(201)
    const sessionId = (created.body as { session: { sessionId: string } }).session.sessionId
    const sent = await jsonOf(await post(`/api/runtime/sessions/${sessionId}/messages`, { clientRef: 'c1', text: 'hi' }, d))
    expect(sent.status).toBe(202)
    await waitFor(async () => {
      const r = await bundle.host.store.latestRun(sessionId)
      return r && r.status !== 'running' ? r : null
    })

    await bundle.host.dispose()
    hosts.splice(0)
    // create + resume + send, each lost and each counted exactly once.
    expect(bundle.host.auditFailures()).toBe(3)
    await waitFor(() => (auditFailureCount() - before >= 3 ? true : null))
    expect(auditFailureCount() - before).toBe(3)
  })

  test('with no sink given, the host appends to audit.jsonl BESIDE its session store (0600), content-free', async () => {
    const root = await tempRoot()
    const bundle = await makeBundle(root, {})
    const d = depsFor(bundle)
    const created = await jsonOf(await post('/api/runtime/sessions', { cwd: root, model: 'claude-x', title: SENTINEL }, d))
    expect(created.status).toBe(201)
    await bundle.host.dispose()
    hosts.splice(0)

    const path = join(root, 'audit.jsonl')
    const raw = await readFile(path, 'utf8')
    expect(raw).not.toContain(SENTINEL)
    const parsed = raw.trim().split('\n').map(l => JSON.parse(l) as { action: string; actorId: string; ip: string; at: string })
    expect(parsed.map(p => p.action)).toEqual(['runtime.session.create'])
    expect(parsed[0]!.ip).toBe('203.0.113.7')
    expect(Number.isNaN(Date.parse(parsed[0]!.at))).toBe(false)
    expect((await stat(path)).mode & 0o777).toBe(0o600)
  })
})

// ── the auditor and the local log ───────────────────────────────────────────────────────────────

describe('createRuntimeSessionAuditor', () => {
  test('flush gives up after its bound and counts what is still pending, once', async () => {
    let release: (() => void) | undefined
    const auditor = createRuntimeSessionAuditor({
      actor: 'local:t',
      sink: () => new Promise<boolean>((resolve) => { release = () => resolve(false) }),
    })
    auditor.audit({ verb: 'send', surface: 'tui', sessionId: 's', outcome: 'ok' })
    await auditor.flush(30)
    expect(auditor.failures()).toBe(1)
    release?.()
    await new Promise(r => setTimeout(r, 20))
    expect(auditor.failures()).toBe(1)
  })

  test('a sink answering true is not a failure', async () => {
    const { lines, sink } = capture()
    const auditor = createRuntimeSessionAuditor({ actor: 'local:t', sink })
    auditor.audit({ verb: 'create', surface: 'tui', sessionId: 's', outcome: 'ok' }, { ip: '10.0.0.1' })
    await auditor.flush()
    expect(auditor.failures()).toBe(0)
    expect(lines).toHaveLength(1)
    expect(lines[0]!.ip).toBe('10.0.0.1')
    expect(lines[0]!.meta!.surface).toBe('tui')
  })
})

describe('appendAuditLine', () => {
  test('rotates past the threshold into one .1 generation', async () => {
    const root = await tempRoot()
    const path = join(root, 'nested', 'audit.jsonl')
    const input: AuditInput = { action: 'runtime.session.send', ip: 'local', targetId: 's', meta: { surface: 'cli', outcome: 'ok' } }
    expect(await appendAuditLine(path, input, { maxBytes: 64 })).toBe(true)
    expect(await appendAuditLine(path, input, { maxBytes: 64 })).toBe(true)
    const current = (await readFile(path, 'utf8')).trim().split('\n')
    const previous = (await readFile(`${path}.1`, 'utf8')).trim().split('\n')
    expect(current).toHaveLength(1)
    expect(previous).toHaveLength(1)
  })

  test('the builder still redacts secret-shaped keys on this path', async () => {
    const root = await tempRoot()
    const path = join(root, 'audit.jsonl')
    await appendAuditLine(path, { action: 'runtime.session.create', ip: 'local', meta: { token: SENTINEL, surface: 'cli' } })
    expect(await readFile(path, 'utf8')).not.toContain(SENTINEL)
  })

  test('a write that fails answers false, never throws, and is counted', async () => {
    const root = await tempRoot()
    const blocker = join(root, 'a-file')
    await writeFile(blocker, 'x')
    const before = auditFailureCount()
    const ok = await appendAuditLine(join(blocker, 'audit.jsonl'), { action: 'runtime.session.send', ip: 'local' })
    expect(ok).toBe(false)
    expect(auditFailureCount() - before).toBe(1)
  })
})
