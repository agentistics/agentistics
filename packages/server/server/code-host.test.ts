/**
 * code-host.test.ts — the SERVER half of the `code` tab, fully offline: a scripted `ProviderClient`,
 * a real sqlite store + content store + native tools/policy in a temp dir, an in-memory board. No
 * network, no key, no journal. The shape `runtime-sessions-web.test.ts` and `cli-code.test.ts` use.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fromAnthropicStopReason, fromAnthropicUsage, classifyProviderError } from '@agentistics/core'
import type { CodeEvent, CodeAsk } from '@agentistics/tui/control/code-types'
import type { InvocationResult, ProviderClient, ProviderContent, ProviderMessage, ProviderRequest } from '@agentistics/runtime'
import {
  catalogueName, createCodeHost, denyIndexOf, diffOfPatch, diffOfWrite, historyOf, shortSessionId, shortTaskRef, targetOf, verbOf, whyOf,
  type CodeTasksApi, type ServerCodeHost,
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

async function rig(client: ProviderClient, over: { model?: string; flagOn?: boolean; central?: boolean; paths?: { dbPath: string; contentDir: string; workspace: string } } = {}): Promise<Rig> {
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
    expect(res.facts.mode).toBe('ask')
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
