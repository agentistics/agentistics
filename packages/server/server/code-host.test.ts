/**
 * code-host.test.ts — the SERVER half of the `code` tab, fully offline: a scripted `ProviderClient`,
 * a real sqlite store + content store + native tools/policy in a temp dir, an in-memory board. No
 * network, no key, no journal. The shape `runtime-sessions-web.test.ts` and `cli-code.test.ts` use.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fromAnthropicStopReason, fromAnthropicUsage, classifyProviderError } from '@agentistics/core'
import type { CodeEvent, CodeAsk } from '@agentistics/tui/control/code-types'
import type { InvocationResult, ProviderClient, ProviderContent, ProviderMessage, ProviderRequest } from '@agentistics/runtime'
import {
  catalogueName, costsOf, createCodeHost, denyIndexOf, diffOfPatch, diffOfWrite, historyOf, nextMode, outputOf, shortSessionId, shortTaskRef,
  stopReasonText, targetOf, verbOf, whyOf,
  type CodeHostOptions, type CodeTasksApi, type ServerCodeHost,
} from './code-host'
import { createRuntimeHost, type RuntimeHost } from './runtime-host'

const use = (id: string, name: string, input: unknown): ProviderContent => ({ type: 'tool_use', id, name, input })

function scripted(turns: ProviderContent[][]): ProviderClient {
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
        startedAt: '2026-09-28T12:00:00.000Z', latencyMs: 5, status: 'completed', messageId: `msg_${n}`,
        servedModel: req.model, usage: fromAnthropicUsage({ input_tokens: 10, output_tokens: 5 }).usage,
        usageAnomalies: [], content,
        stopReason: fromAnthropicStopReason(content.some(c => c.type === 'tool_use') ? 'tool_use' : 'end_turn'),
      }
    },
  }
}

/** A client whose one attempt hangs until the caller's signal aborts — for the cancel test. */
function hanging(): ProviderClient {
  return {
    provider: 'anthropic',
    adapterVersion: 'stub@1',
    capabilities: { streaming: false, editPolicy: 'verbatim' as never },
    async invokeOnce(req: ProviderRequest, attempt): Promise<InvocationResult> {
      return await new Promise<InvocationResult>(resolve => {
        req.signal?.addEventListener('abort', () => resolve({
          invocationId: req.correlation.invocationId, attempt, provider: 'anthropic', requestedModel: req.model,
          startedAt: '2026-09-28T12:00:00.000Z', latencyMs: 1, status: 'failed',
          error: classifyProviderError({ transport: 'aborted' }),
        }), { once: true })
      })
    },
  }
}

// ── harness ─────────────────────────────────────────────────────────────────────────────────────

const roots: string[] = []
const hosts: ServerCodeHost[] = []
const runtimes: RuntimeHost[] = []

afterEach(async () => {
  for (const h of hosts.splice(0)) await h.dispose().catch(() => {})
  for (const r of runtimes.splice(0)) await r.dispose().catch(() => {})
  for (const d of roots.splice(0)) await rm(d, { recursive: true, force: true })
})

async function tempDir(prefix: string): Promise<string> {
  const d = await realpath(await mkdtemp(join(tmpdir(), prefix)))
  roots.push(d)
  return d
}

interface Board {
  api: CodeTasksApi
  filed: { taskId: string; sessionId: string }[]
  failAttach: boolean
}

function board(tasks: { id: string; title: string; status: string }[]): Board {
  const b: Board = { filed: [], failAttach: false, api: null as never }
  b.api = {
    async list() { return tasks },
    async statuses() { return [{ id: 'todo', label: 'To do' }, { id: 'in_progress', label: 'In progress' }, { id: 'done', label: 'Done' }] },
    async create(title) {
      const t = { id: `t-${'ab12'}${tasks.length}0000`, title, status: 'todo' }
      tasks.push(t)
      return t
    },
    async attach(taskId, sessionId) {
      if (b.failAttach) return { ok: false, reason: 'boom' }
      b.filed.push({ taskId, sessionId })
      return { ok: true }
    },
    async taskOf(sessionId) {
      const f = b.filed.find(x => x.sessionId === sessionId)
      const t = f && tasks.find(x => x.id === f.taskId)
      return t ? { taskId: t.id, title: t.title } : null
    },
  }
  return b
}

interface Rig {
  host: ServerCodeHost
  board: Board
  workspace: string
  dbPath: string
  contentDir: string
  runtime: () => Promise<RuntimeHost>
}

async function rig(client: ProviderClient, over: { model?: string; flagOn?: boolean; central?: boolean; paths?: { dbPath: string; contentDir: string; workspace: string }; host?: Partial<CodeHostOptions> } = {}): Promise<Rig> {
  const workspace = over.paths?.workspace ?? await tempDir('agt-code-ws-')
  const data = over.paths ? null : await tempDir('agt-code-data-')
  const dbPath = over.paths?.dbPath ?? join(data!, 'sessions.db')
  const contentDir = over.paths?.contentDir ?? join(data!, 'content')
  const b = board([{ id: 't-0001abcdef', title: 'Fix the login', status: 'todo' }, { id: 't-0002abcdef', title: 'Old work', status: 'done' }])
  const runtime = async () => {
    const r = await createRuntimeHost({
      dbPath, contentDir, journal: null, clientFor: () => client,
      pid: process.pid, isAlive: () => true, runtimeVersion: 'runtime@code-host-test',
    })
    runtimes.push(r)
    return r
  }
  let runtimeP: Promise<RuntimeHost> | null = null
  const host = createCodeHost({
    lang: () => 'en',
    ...(over.model ? { model: over.model } : {}),
    cwd: workspace,
    runtime: () => (runtimeP ??= runtime()),
    flagOn: () => over.flagOn ?? true,
    central: () => over.central ?? false,
    tasks: b.api,
    ...(over.host ?? {}),
  })
  hosts.push(host)
  return { host, board: b, workspace, dbPath, contentDir, runtime: () => (runtimeP ??= runtime()) }
}

function watch(host: ServerCodeHost, sessionId: string) {
  const events: CodeEvent[] = []
  const off = host.subscribe(sessionId, e => events.push(e))
  const waitFor = async <T extends CodeEvent>(pred: (e: CodeEvent) => e is T, ms = 4000): Promise<T> => {
    const until = Date.now() + ms
    for (;;) {
      const hit = events.find(pred)
      if (hit) return hit
      if (Date.now() > until) throw new Error(`timed out; saw ${JSON.stringify(events.map(e => e.kind))}`)
      await new Promise(r => setTimeout(r, 15))
    }
  }
  return { events, off, waitFor }
}

const isAsk = (e: CodeEvent): e is Extract<CodeEvent, { kind: 'ask' }> => e.kind === 'ask'
const isRunEnded = (e: CodeEvent): e is Extract<CodeEvent, { kind: 'run-ended' }> => e.kind === 'run-ended'
const isRunStarted = (e: CodeEvent): e is Extract<CodeEvent, { kind: 'run-started' }> => e.kind === 'run-started'
const toolIn = (state: string) => (e: CodeEvent): e is Extract<CodeEvent, { kind: 'tool' }> => e.kind === 'tool' && e.call.state === state

const PATCH_ADD = ['*** Begin Patch', '*** Add File: notes.txt', '+first line', '+second line', '*** End Patch'].join('\n')

async function started(r: Rig, firstMessage?: string) {
  const res = await r.host.start({ taskId: 't-0001abcdef', model: 'claude-test-1', cwd: r.workspace, ...(firstMessage ? { firstMessage } : {}) })
  if (!res.ok) throw new Error(res.sentence)
  return res
}

// ── tests ───────────────────────────────────────────────────────────────────────────────────────

describe('availability and defaults', () => {
  test('off when the flag is off, and when this is a central — each in words', async () => {
    const off = await rig(scripted([]), { flagOn: false })
    const a = off.host.availability()
    expect(a.ok).toBe(false)
    if (!a.ok) expect(a.sentence).toContain('AGENTISTICS_PROVIDER')
    const cen = await rig(scripted([]), { central: true })
    const c = cen.host.availability()
    expect(c.ok).toBe(false)
    expect((await rig(scripted([]))).host.availability()).toEqual({ ok: true })
  })

  test('the model comes from the flag, else the last native session, else nowhere', async () => {
    const withFlag = await rig(scripted([]), { model: 'claude-flag' })
    expect((await withFlag.host.defaults()).model).toEqual({ id: 'claude-flag', source: 'flag' })

    const none = await rig(scripted([]))
    const d0 = await none.host.defaults()
    expect(d0.model).toBeNull()
    expect(d0.noModelSentence).toContain('--model')
    expect(d0.provider).toBe('anthropic')
    expect(d0.cwd).toBe(none.workspace)

    // A session that ran under some model, then a fresh host with NO flag on the same store.
    await started(none)
    const again = await rig(scripted([]), { paths: { dbPath: none.dbPath, contentDir: none.contentDir, workspace: none.workspace } })
    expect((await again.host.defaults()).model).toEqual({ id: 'claude-test-1', source: 'last-session' })
  })
})

describe('tasks', () => {
  test('lists open tasks only, with the board status label; creates a todo task', async () => {
    const r = await rig(scripted([]))
    const open = await r.host.openTasks()
    expect(open.ok).toBe(true)
    if (open.ok) {
      expect(open.tasks.map(t => t.title)).toEqual(['Fix the login'])
      expect(open.tasks[0]).toMatchObject({ ref: 't-0001', status: 'todo', statusLabel: 'To do' })
    }
    const made = await r.host.createTask('  New thing  ')
    expect(made.ok).toBe(true)
    if (made.ok) expect(made.task).toMatchObject({ title: 'New thing', status: 'todo' })
    expect((await r.host.createTask('   ')).ok).toBe(false)
  })
})

describe('start', () => {
  test('refuses without a task, without a model, and for a task the board does not have', async () => {
    const r = await rig(scripted([]))
    const noTask = await r.host.start({ taskId: '', model: 'm', cwd: r.workspace })
    expect(noTask.ok).toBe(false)
    const noModel = await r.host.start({ taskId: 't-0001abcdef', model: ' ', cwd: r.workspace })
    expect(noModel.ok).toBe(false)
    const ghost = await r.host.start({ taskId: 't-nope', model: 'm', cwd: r.workspace })
    expect(ghost.ok).toBe(false)
    expect(r.board.filed).toEqual([])
  })

  test('files the session under the task, names it back, and runs the first message', async () => {
    const r = await rig(scripted([[{ type: 'text', text: 'hello there' }]]))
    const res = await started(r, 'say hello')
    expect(r.board.filed).toEqual([{ taskId: 't-0001abcdef', sessionId: res.facts.sessionId }])
    expect(res.facts.task).toMatchObject({ id: 't-0001abcdef', ref: 't-0001', title: 'Fix the login' })
    expect(res.facts.mode).toBe('default')
    expect(res.facts.shortId).toBe(shortSessionId(res.facts.sessionId))
    expect(res.sentence).toContain('t-0001')

    const w = watch(r.host, res.facts.sessionId)
    const ended = await w.waitFor(isRunEnded)
    expect(ended.status).toBe('completed')
    expect(w.events.find(e => e.kind === 'user')).toMatchObject({ text: 'say hello' })
    const usage = w.events.find(e => e.kind === 'usage')
    expect(usage).toMatchObject({ usage: { model: 'claude-test-1', input: 10, output: 5 } })
    // A counter the scripted source did not report is ABSENT, not 0.
    if (usage?.kind === 'usage') expect('cacheRead' in usage.usage && usage.usage.cacheRead === 0).toBe(false)
    w.off()
  })

  test('a session that cannot be filed does not stay open', async () => {
    const r = await rig(scripted([]))
    r.board.failAttach = true
    const res = await r.host.start({ taskId: 't-0001abcdef', model: 'claude-test-1', cwd: r.workspace })
    expect(res.ok).toBe(false)
    const rt = await r.runtime()
    const page = await rt.store.listSessions({ limit: 5 })
    expect(page.sessions.every(s => s.status !== 'open')).toBe(true)
    expect((await rt.store.getLease(page.sessions[0]!.sessionId))).toBeNull()
  })
})

describe('a write that needs approval', () => {
  test('the ask carries the exact diff and the policy\'s own options; allowing runs it', async () => {
    const r = await rig(scripted([
      [use('tu_1', 'file__patch', { patch: PATCH_ADD })],
      [{ type: 'text', text: 'done' }],
    ]))
    const res = await started(r, 'add notes')
    const w = watch(r.host, res.facts.sessionId)
    const ask = (await w.waitFor(isAsk)).ask as CodeAsk

    expect(ask.kind).toBe('permission')
    expect(ask.toolName).toBe('file.patch')
    expect(ask.diff?.files).toHaveLength(1)
    const f = ask.diff!.files[0]!
    expect(f).toMatchObject({ path: 'notes.txt', op: 'add', added: 2, removed: 0 })
    expect(f.hunks[0]!.lines).toEqual([{ op: '+', text: 'first line' }, { op: '+', text: 'second line' }])
    expect(ask.options[0]!.label).toBe('Allow once')
    expect(ask.options.at(-1)!.label).toBe('Deny')
    expect(ask.denyIndex).toBe(ask.options.length - 1)
    expect(ask.checkpoint).toBe(false)
    expect(ask.why.length).toBeGreaterThan(0)
    expect(ask.paths?.some(p => p.path.endsWith('notes.txt'))).toBe(true)
    // The running tool row went to `asking`, and it already carries the same diff.
    const asking = (await w.waitFor(toolIn('asking'))).call
    expect(asking.diff).toEqual(ask.diff)
    expect(asking.target).toBe('notes.txt')

    expect(r.host.answer(res.facts.sessionId, ask.id, 0)).toMatchObject({ ok: true })
    const done = (await w.waitFor(toolIn('done'))).call
    expect(done.diff).toEqual(ask.diff)
    expect(done.linesAdded).toBe(2)
    const closed = await w.waitFor((e): e is Extract<CodeEvent, { kind: 'ask-closed' }> => e.kind === 'ask-closed')
    expect(closed).toMatchObject({ outcome: 'answered', choiceLabel: 'Allow once' })
    await w.waitFor(isRunEnded)
    expect(existsSync(join(r.workspace, 'notes.txt'))).toBe(true)
    w.off()
  })

  test('denying is refused in words and nothing is written; a second answer says the question is gone', async () => {
    const r = await rig(scripted([
      [use('tu_1', 'file__patch', { patch: PATCH_ADD })],
      [{ type: 'text', text: 'ok' }],
    ]))
    const res = await started(r, 'add notes')
    const w = watch(r.host, res.facts.sessionId)
    const ask = (await w.waitFor(isAsk)).ask
    expect(ask.denyIndex).not.toBeNull()
    expect(r.host.answer(res.facts.sessionId, ask.id, ask.denyIndex!).ok).toBe(true)
    const denied = (await w.waitFor(toolIn('denied'))).call
    expect(denied.failure).toBe('denied by you')
    await w.waitFor(isRunEnded)
    expect(existsSync(join(r.workspace, 'notes.txt'))).toBe(false)
    const again = r.host.answer(res.facts.sessionId, ask.id, 0)
    expect(again.ok).toBe(false)
    w.off()
  })

  test('a file.write is diffed from its own input', async () => {
    const r = await rig(scripted([
      [use('tu_1', 'file__write', { path: 'w.txt', content: 'a\nb\nc' })],
      [{ type: 'text', text: 'ok' }],
    ]))
    const res = await started(r, 'write')
    const w = watch(r.host, res.facts.sessionId)
    const ask = (await w.waitFor(isAsk)).ask
    expect(ask.diff?.files[0]).toMatchObject({ path: 'w.txt', op: 'add', added: 3 })
    r.host.answer(res.facts.sessionId, ask.id, ask.denyIndex!)
    await w.waitFor(isRunEnded)
    w.off()
  })
})

describe('cancel and input', () => {
  test('cancel aborts the run in progress; with nothing running it says so', async () => {
    const r = await rig(hanging())
    const res = await started(r, 'wait forever')
    const w = watch(r.host, res.facts.sessionId)
    await w.waitFor(isRunStarted)
    expect(r.host.cancel(res.facts.sessionId).ok).toBe(true)
    const ended = await w.waitFor(isRunEnded)
    expect(['abandoned', 'failed']).toContain(ended.status)
    await new Promise(r2 => setTimeout(r2, 50))
    const nothing = r.host.cancel(res.facts.sessionId)
    expect(nothing.ok).toBe(false)
    w.off()
  })

  test('input to a session nobody drives is refused in words', async () => {
    const r = await rig(scripted([[{ type: 'text', text: 'hi' }]]))
    const res = await started(r)
    await r.host.end(res.facts.sessionId)
    const out = r.host.submit(res.facts.sessionId, 'anyone there?')
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.sentence).toContain('not being driven')
    // The lease is released: another process could take it.
    const rt = await r.runtime()
    expect(await rt.store.getLease(res.facts.sessionId)).toBeNull()
  })
})

describe('resume', () => {
  test('emits the stored turns (text and tool names, never results) and finds the task', async () => {
    const r = await rig(scripted([
      [use('tu_1', 'file__read', { path: 'a.txt' })],
      [{ type: 'text', text: 'read it' }],
    ]))
    await writeFile(join(r.workspace, 'a.txt'), 'x\n')
    const res = await started(r, 'look at a.txt')
    const w = watch(r.host, res.facts.sessionId)
    await w.waitFor(isRunEnded)
    w.off()
    await r.host.end(res.facts.sessionId)

    const back = await r.host.resume(res.facts.sessionId)
    expect(back.ok).toBe(true)
    if (!back.ok) return
    expect(back.facts.task?.id).toBe('t-0001abcdef')
    const w2 = watch(r.host, res.facts.sessionId)
    const hist = await w2.waitFor((e): e is Extract<CodeEvent, { kind: 'history' }> => e.kind === 'history')
    expect(hist.turns[0]).toMatchObject({ role: 'user', text: 'look at a.txt' })
    const withTool = hist.turns.find(t => t.tools.length > 0)
    expect(withTool?.tools[0]).toEqual({ name: 'file.read', verb: 'read', target: 'a.txt' })
    expect(JSON.stringify(hist)).not.toContain('tool_result')
    w2.off()
    expect((await r.host.resume('ses_missing')).ok).toBe(false)
  })
})

describe('pure translation helpers', () => {
  test('an update patch keeps its context header and counts its own +/- lines', () => {
    const patch = ['*** Begin Patch', '*** Update File: src/a.ts', '@@ function f', ' keep', '-old', '+new', '+extra', '*** End Patch'].join('\n')
    const d = diffOfPatch(patch)!
    expect(d.files[0]).toMatchObject({ path: 'src/a.ts', op: 'update', added: 2, removed: 1 })
    expect(d.files[0]!.hunks[0]).toEqual({
      header: 'function f',
      lines: [{ op: ' ', text: 'keep' }, { op: '-', text: 'old' }, { op: '+', text: 'new' }, { op: '+', text: 'extra' }],
    })
  })

  test('a delete names no lines it cannot know; a malformed patch has no diff', () => {
    const del = diffOfPatch(['*** Begin Patch', '*** Delete File: gone.txt', '*** End Patch'].join('\n'))!
    expect(del.files[0]).toEqual({ path: 'gone.txt', op: 'delete', added: 0, removed: 0, hunks: [] })
    expect(diffOfPatch('not a patch')).toBeNull()
  })

  test('write diffs, targets, verbs, why, deny index, refs', () => {
    expect(diffOfWrite('x', 'a\nb', true).files[0]).toMatchObject({ op: 'overwrite', added: 2 })
    expect(targetOf('fs.grep', { pattern: 'foo' })).toBe('foo')
    expect(targetOf('shell.start', { command: 'ls   -la' })).toBe('ls -la')
    expect(targetOf('file.read', 42)).toBe('')
    expect(catalogueName('fs__grep')).toBe('fs.grep')
    expect(catalogueName('mystery__x')).toBe('mystery__x')
    expect(verbOf('file.patch')).toBe('patch')
    expect(verbOf('mystery.tool')).toBe('mystery.tool')
    expect(whyOf('Allow `file.patch` to run?\n\nIt needs your approval because:\n- writes a file\n- outside the allowlist')).toEqual(['writes a file', 'outside the allowlist'])
    expect(whyOf('no marker here')).toEqual([])
    expect(denyIndexOf([{ label: 'Allow once' }, { label: 'Deny' }])).toBe(1)
    expect(denyIndexOf([{ label: 'Yes' }, { label: 'No' }])).toBeNull()
    expect(shortTaskRef('t-0539886b9c')).toBe('t-0539')
    expect(shortSessionId('ses_3f5f21a8')).toBe('3f5f')
  })

  test('history skips tool-result-only turns', () => {
    const msgs: { message: ProviderMessage }[] = [
      { message: { role: 'user', content: 'hi' } },
      { message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }, { type: 'tool_use', id: 'x', name: 'fs.glob', input: { pattern: '*.ts' } }] } },
      { message: { role: 'user', content: [{ type: 'tool_result', toolUseId: 'x', content: 'SECRET', isError: false }] } },
    ]
    const turns = historyOf(msgs)
    expect(turns).toHaveLength(2)
    expect(turns[1]!.tools).toEqual([{ name: 'fs.glob', verb: 'glob', target: '*.ts' }])
    expect(JSON.stringify(turns)).not.toContain('SECRET')
  })
})

// ── P2 ──────────────────────────────────────────────────────────────────────────────────────────

/** A STREAMING client: `started`, a text delta after a short pause, then `end`. All four counters. */
function streamingText(text: string, delayMs = 15): ProviderClient {
  let n = 0
  const result = (req: ProviderRequest, attempt: number): InvocationResult => {
    n += 1
    return {
      invocationId: req.correlation.invocationId, attempt, provider: 'anthropic', requestedModel: req.model,
      startedAt: '2026-09-28T12:00:00.000Z', latencyMs: 42, status: 'completed', messageId: `msg_s${n}`,
      servedModel: req.model,
      usage: fromAnthropicUsage({ input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 5000, cache_creation_input_tokens: 300 }).usage,
      usageAnomalies: [], content: [{ type: 'text', text }], stopReason: fromAnthropicStopReason('end_turn'),
    }
  }
  return {
    provider: 'anthropic',
    adapterVersion: 'stub-stream@1',
    capabilities: { streaming: true, editPolicy: 'verbatim' as never },
    async invokeOnce(req, attempt) { return result(req, attempt) },
    async *stream(req, attempt) {
      yield { type: 'started', messageId: 'msg_s' }
      await new Promise(r => setTimeout(r, delayMs))
      yield { type: 'text-delta', index: 0, text }
      yield { type: 'end', result: result(req, attempt) }
    },
  }
}

const isUsage = (e: CodeEvent): e is Extract<CodeEvent, { kind: 'usage' }> => e.kind === 'usage'
const isRules = (e: CodeEvent): e is Extract<CodeEvent, { kind: 'rules' }> => e.kind === 'rules'
const isMode = (e: CodeEvent): e is Extract<CodeEvent, { kind: 'mode' }> => e.kind === 'mode'

describe('CD-06/CD-13: per-call model facts on usage', () => {
  test('a streamed response carries ttft, times, latency, stop reason and per-counter costs that sum to the total', async () => {
    const r = await rig(streamingText('hi there'))
    const res = await r.host.start({ taskId: 't-0001abcdef', model: 'claude-sonnet-4-6', cwd: r.workspace, firstMessage: 'hello' })
    if (!res.ok) throw new Error(res.sentence)
    const w = watch(r.host, res.facts.sessionId)
    const u = (await w.waitFor(isUsage)).usage
    expect(u.attemptId).toMatch(/^inv_/)
    expect(typeof u.startedAt).toBe('string')
    expect(typeof u.endedAt).toBe('string')
    expect(u.ttftMs).toBeGreaterThanOrEqual(0)
    expect(u.latencyMs).toBe(42)
    expect(u.stopReason).toBe('end_turn')
    expect(u.costs).toBeDefined()
    const sum = u.costs!.input + u.costs!.output + u.costs!.cacheRead + u.costs!.cacheWrite
    expect(Math.abs(sum - u.costUSD!)).toBeLessThan(1e-12)
    expect(u.costs!.input).toBeCloseTo(1000 / 1e6 * 3, 12)
    await w.waitFor(isRunEnded)
    w.off()
  })

  test('a non-streaming client yields no ttft (absent, never 0); an unpriced model has neither cost nor costs', async () => {
    const r = await rig(scripted([[use('tu_1', 'fs__glob', { pattern: '*.none' })], [{ type: 'text', text: 'ok' }]]))
    const res = await started(r, 'glob')
    const w = watch(r.host, res.facts.sessionId)
    await w.waitFor(isRunEnded)
    const usages = w.events.filter(isUsage).map(e => e.usage)
    expect(usages.length).toBe(2)
    for (const u of usages) {
      expect('ttftMs' in u).toBe(false)
      expect('costUSD' in u).toBe(false)
      expect('costs' in u).toBe(false)
      expect(typeof u.startedAt).toBe('string')
    }
    expect(usages[0]!.stopReason).toBe('tool_use')
    expect(usages[1]!.stopReason).toBe('end_turn')
    w.off()
  })
})

describe('CD-13/CD-14/CD-10: per-tool facts', () => {
  test('an asked-and-allowed call carries its times, the question span and the policy decision', async () => {
    const r = await rig(scripted([[use('tu_1', 'file__patch', { patch: PATCH_ADD })], [{ type: 'text', text: 'done' }]]))
    const res = await started(r, 'add notes')
    const w = watch(r.host, res.facts.sessionId)
    const ask = (await w.waitFor(isAsk)).ask
    const asking = (await w.waitFor(toolIn('asking'))).call
    expect(typeof asking.requestedAt).toBe('string')
    expect(asking.waited?.openedAt).toBeDefined()
    expect(asking.waited?.closedAt).toBeUndefined()
    r.host.answer(res.facts.sessionId, ask.id, 0)
    const done = (await w.waitFor(toolIn('done'))).call
    expect(done.policy).toMatchObject({ decision: 'allowed', by: 'user', asked: true })
    expect(typeof done.policy!.rule).toBe('string')
    expect(done.waited?.closedAt).toBeDefined()
    expect(typeof done.endedAt).toBe('string')
    await w.waitFor(isRunEnded)
    w.off()
  })

  test('a denial names its code; an auto-allowed read was never asked and returns its text', async () => {
    const r = await rig(scripted([
      [use('tu_1', 'file__read', { path: 'a.txt' })],
      [use('tu_2', 'file__patch', { patch: PATCH_ADD })],
      [{ type: 'text', text: 'ok' }],
    ]))
    await writeFile(join(r.workspace, 'a.txt'), 'alpha\nbeta\n')
    const res = await started(r, 'read then patch')
    const w = watch(r.host, res.facts.sessionId)
    const read = (await w.waitFor((e): e is Extract<CodeEvent, { kind: 'tool' }> => e.kind === 'tool' && e.call.name === 'file.read' && e.call.state === 'done')).call
    expect(read.policy).toMatchObject({ decision: 'allowed', by: 'policy', asked: false })
    expect(read.waited).toBeUndefined()
    expect(read.output?.lines.join('\n')).toContain('beta')
    expect(read.output!.total).toBeGreaterThanOrEqual(2)
    const ask = (await w.waitFor(isAsk)).ask
    r.host.answer(res.facts.sessionId, ask.id, ask.denyIndex!)
    const denied = (await w.waitFor(toolIn('denied'))).call
    expect(denied.policy).toMatchObject({ decision: 'denied', by: 'user', asked: true, code: 'policy.denied.by-person' })
    expect(typeof denied.endedAt).toBe('string')
    await w.waitFor(isRunEnded)
    w.off()
  })
})

describe('CD-15/CD-16: modes and session rules', () => {
  test('an "allow for this session" answer becomes a rule; a looser mode drops it, journaled as counts', async () => {
    const data = await tempDir('agt-code-journal-')
    const journalPath = join(data, 'profile-switches.jsonl')
    const r = await rig(scripted([
      [use('tu_1', 'file__patch', { patch: PATCH_ADD })],
      [{ type: 'text', text: 'ok' }],
    ]), { host: { modeJournalPath: journalPath } })
    const res = await started(r, 'add notes')
    const w = watch(r.host, res.facts.sessionId)
    const ask = (await w.waitFor(isAsk)).ask
    const sessionIdx = ask.options.findIndex(o => o.label.startsWith('Allow for this session'))
    expect(sessionIdx).toBeGreaterThan(0)
    r.host.answer(res.facts.sessionId, ask.id, sessionIdx)
    const rules = await w.waitFor((e): e is Extract<CodeEvent, { kind: 'rules' }> => isRules(e) && e.rules.length === 1)
    expect(rules.rules[0]!.label.length).toBeGreaterThan(0)
    expect(typeof rules.rules[0]!.at).toBe('string')
    await w.waitFor(isRunEnded)
    // Emitted only when changed: one list with the rule, not one per event.
    expect(w.events.filter(isRules).filter(e => e.rules.length === 1)).toHaveLength(1)

    const out = r.host.cycleMode(res.facts.sessionId)
    expect(out).toMatchObject({ ok: true, mode: 'accept-edits' })
    if (out.ok) {
      expect(out.sentence).toContain('edits')
      expect(out.sentence).toStartWith('1 session rule dropped.')
    }
    expect(w.events.find(isMode)).toEqual({ kind: 'mode', mode: 'accept-edits', direction: 'looser', dropped: 1 })
    expect(w.events.filter(isRules).at(-1)!.rules).toEqual([])

    const lines = (await readFile(journalPath, 'utf-8')).trim().split('\n').map(l => JSON.parse(l))
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatchObject({ sessionId: res.facts.sessionId, code: 'policy.profile.switched', from: 'default', to: 'accept-edits', direction: 'looser', kept: 0, dropped: 1 })
    expect(JSON.stringify(lines[0])).not.toContain(rules.rules[0]!.label)

    expect(r.host.cycleMode(res.facts.sessionId)).toMatchObject({ ok: true, mode: 'plan' })
    expect(r.host.cycleMode(res.facts.sessionId)).toMatchObject({ ok: true, mode: 'default' })
    w.off()
  })

  test('plan refuses a write WITHOUT asking — the switch reached the policy the run judges with', async () => {
    const data = await tempDir('agt-code-journal-')
    const r = await rig(scripted([
      [use('tu_1', 'file__patch', { patch: PATCH_ADD })],
      [{ type: 'text', text: 'ok' }],
    ]), { host: { modeJournalPath: join(data, 'j.jsonl') } })
    const res = await started(r)
    expect(r.host.cycleMode(res.facts.sessionId)).toMatchObject({ ok: true, mode: 'accept-edits' })
    const plan = r.host.cycleMode(res.facts.sessionId)
    expect(plan).toMatchObject({ ok: true, mode: 'plan' })
    if (plan.ok) expect(plan.sentence).toContain('read-only')
    const w = watch(r.host, res.facts.sessionId)
    expect(r.host.submit(res.facts.sessionId, 'add notes').ok).toBe(true)
    const denied = (await w.waitFor(toolIn('denied'))).call
    expect(denied.policy).toMatchObject({ decision: 'denied', by: 'policy', asked: false })
    expect(denied.policy!.rule).toContain('plan')
    await w.waitFor(isRunEnded)
    expect(w.events.some(isAsk)).toBe(false)
    expect(existsSync(join(r.workspace, 'notes.txt'))).toBe(false)
    w.off()
  })

  test('an unknown session is refused in words; a failed journal write costs the line, not the switch', async () => {
    const r = await rig(scripted([]), { host: { modeJournalPath: '/proc/definitely/not/writable/j.jsonl' } })
    const none = r.host.cycleMode('ses_nope')
    expect(none.ok).toBe(false)
    const res = await started(r)
    const out = r.host.cycleMode(res.facts.sessionId)
    expect(out).toMatchObject({ ok: true, mode: 'accept-edits' })
    if (out.ok) expect(out.sentence).toContain('could not be written')
    // An ended session is no longer one this host may switch.
    await r.host.end(res.facts.sessionId)
    expect(r.host.cycleMode(res.facts.sessionId).ok).toBe(false)
  })

  test('policyOf is the SAME object the runtime judges with, created before the first run; finish evicts it', async () => {
    const data = await tempDir('agt-code-data-')
    const ws = await tempDir('agt-code-ws-')
    const rt = await createRuntimeHost({
      dbPath: join(data, 's.db'), contentDir: join(data, 'c'), journal: null, pid: process.pid, isAlive: () => true,
      clientFor: () => scripted([[use('tu_1', 'file__write', { path: 'x.txt', content: 'x' })], [{ type: 'text', text: 'ok' }]]),
    })
    runtimes.push(rt)
    const s = await rt.runtime.create({ workspaceRoot: ws, cwd: ws, provider: 'anthropic', model: 'claude-test-1', credential: { provider: 'anthropic', id: 'default' } })
    const p = rt.policyOf(s.sessionId)
    expect(rt.policyOf(s.sessionId)).toBe(p)
    p.switchProfile('plan')
    const watcher = rt.hub.watch(s.sessionId)
    const denials: { policy: string; decidedBy: string }[] = []
    const reading = (async () => {
      for await (const f of watcher) {
        if (f.kind === 'event' && f.event.type === 'policy.denied') denials.push(f.event.data as { policy: string; decidedBy: string })
      }
    })()
    const out = await rt.runtime.run(s.sessionId, 'write it')
    expect(out.ok).toBe(true)
    await new Promise(res => setTimeout(res, 20))
    watcher.close()
    await reading
    // Under `default` the write would have ASKED (and been denied as unanswered, by `default:*`);
    // under `plan` the profile's own rule refuses it — the verdict names that rule.
    expect(denials).toHaveLength(1)
    expect(denials[0]).toMatchObject({ decidedBy: 'policy' })
    expect(denials[0]!.policy).toContain('profile.plan')
    expect(existsSync(join(ws, 'x.txt'))).toBe(false)
    expect(rt.policyOf(s.sessionId)).toBe(p)
    expect(p.profile()).toBe('plan')
    await rt.runtime.finish(s.sessionId)
    expect(rt.policyOf(s.sessionId)).not.toBe(p)
    expect(rt.policyOf(s.sessionId).profile()).toBe('default')
  })
})

describe('CD-18: prompt history', () => {
  test('user prompts across sessions, newest first, identical texts once (the newest kept)', async () => {
    const r = await rig(scripted([
      [{ type: 'text', text: 'a1' }], [{ type: 'text', text: 'a2' }], [{ type: 'text', text: 'b1' }],
    ]))
    const a = await started(r, 'alpha')
    const wa = watch(r.host, a.facts.sessionId)
    await wa.waitFor(isRunEnded)
    wa.events.length = 0
    r.host.submit(a.facts.sessionId, 'beta')
    await wa.waitFor(isRunEnded)
    wa.off()
    await new Promise(res => setTimeout(res, 5))
    const b = await started(r, 'alpha')
    const wb = watch(r.host, b.facts.sessionId)
    await wb.waitFor(isRunEnded)
    wb.off()

    const h = await r.host.promptHistory()
    expect(h.ok).toBe(true)
    if (!h.ok) return
    expect(h.prompts.map(p => p.text)).toEqual(['alpha', 'beta'])
    expect(h.prompts[0]!.sessionId).toBe(b.facts.sessionId)
    expect(h.prompts[1]!.sessionId).toBe(a.facts.sessionId)
    // The ANSWERS are never history. Asserted on the texts, not the JSON: a random session id can
    // itself contain "a1", which made this flaky.
    expect(h.prompts.some(p => /\b(a1|a2|b1)\b/.test(p.text))).toBe(false)
  })
})

describe('CD-17: editDraft', () => {
  test('without an editor it refuses in words; with one it answers what the editor saved', async () => {
    const bare = await rig(scripted([]))
    const r0 = await bare.host.editDraft('x')
    expect(r0.ok).toBe(false)
    if (!r0.ok) expect(r0.sentence).toContain('editor')
    const withEd = await rig(scripted([]), { host: { editor: async d => ({ ok: true, text: `${d}!`, sentence: 'ok' }) } })
    expect(await withEd.host.editDraft('draft')).toEqual({ ok: true, text: 'draft!', sentence: 'ok' })
    const throwing = await rig(scripted([]), { host: { editor: async () => { throw new Error('boom') } } })
    expect((await throwing.host.editDraft('d')).ok).toBe(false)
  })
})

describe('P2 pure helpers', () => {
  test('nextMode cycles; stopReasonText speaks the provider spelling; outputOf keeps the head and the count', () => {
    expect(nextMode('default')).toBe('accept-edits')
    expect(nextMode('accept-edits')).toBe('plan')
    expect(nextMode('plan')).toBe('default')
    expect(stopReasonText({ normalised: { kind: 'max-tokens' } })).toBe('max_tokens')
    expect(stopReasonText({ normalised: { kind: 'other', raw: 'weird_stop' } })).toBe('weird_stop')
    expect(stopReasonText(undefined)).toBeUndefined()
    expect(outputOf('')).toBeUndefined()
    expect(outputOf('a\nb\n')).toEqual({ lines: ['a', 'b'], total: 2 })
    const big = Array.from({ length: 1000 }, (_, i) => `l${i}`).join('\n')
    const o = outputOf(big)!
    expect(o.total).toBe(1000)
    expect(o.lines).toHaveLength(400)
    expect(o.lines[0]).toBe('l0')
  })

  test('costsOf refuses a missing counter and an unpriced model', () => {
    expect(costsOf('claude-sonnet-4-6', { input: 1, output: 1, cacheRead: 1 })).toBeUndefined()
    expect(costsOf('claude-test-1', { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 })).toBeUndefined()
    expect(costsOf('claude-sonnet-4-6', { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 })).toEqual({ input: 3, output: 0, cacheRead: 0, cacheWrite: 0 })
  })
})
