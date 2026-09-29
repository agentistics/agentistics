/**
 * session/undo.test.ts — H4. The pure classification, then the REAL runtime end to end: the real
 * loop and file tools writing through a scripted model, a REAL sqlite store and content store holding
 * the durable checkpoint, the REAL policy judging the undo. Nothing is a double except the model and
 * the person.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fromAnthropicStopReason, fromAnthropicUsage, type AgentisticsEvent } from '@agentistics/core'
import type { CredentialRef, InvocationResult, ProviderClient, ProviderContent } from '../provider/client.ts'
import { createPolicy } from '../policy/index.ts'
import { createNativeTools, type NativeTools } from '../tools/catalogue.ts'
import type { PersonAnswer, PersonAsker, PersonQuestion } from '../tools/contract.ts'
import { createPersistentCheckpointStore, type CheckpointIndex } from './checkpoint-store.ts'
import { createFileContentStore } from './content-store.ts'
import { createRunScheduler } from './scheduler.ts'
import { openSqliteSessionStore } from './sqlite-store.ts'
import { createSessionRuntime, type SessionContentStore, type SessionRuntime } from './runtime.ts'
import type { SessionStore } from './types.ts'
import { classifyUndo, undoLastChange, UNDO_SCOPE_SENTENCE, UNDO_TOOL_NAME } from './undo.ts'

// ── The pure half ────────────────────────────────────────────────────────────────────────────

describe('classifyUndo', () => {
  test('a file the agent created is removed, deleted is recreated, changed is put back', () => {
    const { ready, refused } = classifyUndo([
      { path: '/w/new', recoverable: true, before: null, after: 'x', current: 'x' },
      { path: '/w/gone', recoverable: true, before: 'old', after: null, current: null },
      { path: '/w/edit', recoverable: true, before: 'a', after: 'b', current: 'b' },
    ])
    expect(refused).toEqual([])
    expect(ready).toEqual([
      { path: '/w/new', op: 'delete', restore: null, expect: 'x' },
      { path: '/w/gone', op: 'create', restore: 'old', expect: null },
      { path: '/w/edit', op: 'overwrite', restore: 'a', expect: 'b' },
    ])
  })

  test('a file somebody changed since is refused in a sentence, never put back', () => {
    const { ready, refused } = classifyUndo([
      { path: '/w/edit', recoverable: true, before: 'a', after: 'b', current: 'b, then the person typed' },
      { path: '/w/new', recoverable: true, before: null, after: 'x', current: null }, // removed since
    ])
    expect(ready).toEqual([])
    expect(refused.map(r => [r.path, r.code])).toEqual([['/w/edit', 'changed'], ['/w/new', 'changed']])
    expect(refused[0]!.sentence).toContain('/w/edit changed after the agent wrote it')
  })

  test('a checkpoint that could not be kept is refused as unrecoverable, whatever the disk says', () => {
    const { ready, refused } = classifyUndo([{ path: '/w/f', recoverable: false, before: null, after: null, current: 'z' }])
    expect(ready).toEqual([])
    expect(refused).toEqual([{ path: '/w/f', code: 'unrecoverable', sentence: '/w/f cannot be undone: its checkpoint could not be kept.' }])
  })
})

// ── End to end ───────────────────────────────────────────────────────────────────────────────

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

const use = (id: string, name: string, input: unknown): ProviderContent => ({ type: 'tool_use', id, name, input })
const done: ProviderContent[] = [{ type: 'text', text: 'done' }]

/** A person who answers from a queue, recording every question. Empty queue: nobody answers. */
function person(answers: PersonAnswer[] = []): PersonAsker & { asked: PersonQuestion[] } {
  const asked: PersonQuestion[] = []
  return { asked, async ask(q) { asked.push(q); return answers.shift() ?? { answered: false, reason: 'unavailable' } } }
}
const allowOnce: PersonAnswer = { answered: true, choice: 0 }

const ORIGINAL = "export const greeting = 'hello'\n"
const PATCHED = "export const greeting = 'hello, undo'\n"
const PATCH = [
  '*** Begin Patch',
  '*** Update File: hello.ts',
  '@@',
  "-export const greeting = 'hello'",
  "+export const greeting = 'hello, undo'",
  '*** End Patch',
].join('\n')

let ws: string
let dataDir: string
let store: SessionStore & CheckpointIndex
let content: ReturnType<typeof createFileContentStore>
let native: NativeTools
let events: AgentisticsEvent[]

function openAll(): void {
  store = openSqliteSessionStore(join(dataDir, 'sessions.db'))
  content = createFileContentStore(join(dataDir, 'content'))
  native = createNativeTools({ file: { checkpointStore: createPersistentCheckpointStore(content, store) } })
}

function runtimeWith(client: ProviderClient, asker: PersonAsker): SessionRuntime {
  const journal = { async append(b: readonly AgentisticsEvent[]) { events.push(...b); return { written: b.length, duplicates: 0 } } }
  return createSessionRuntime({
    store, content, journal,
    clientFor: () => client,
    tools: native.tools,
    checkpoints: store,
    policyFactory: () => createPolicy({ layers: [], home: '/home/nobody-h4' }),
    asker,
    runtimeVersion: 'runtime@h4-test',
    scheduler: createRunScheduler({ ceiling: 4 }),
    retry: { sleep: async () => {} },
  })
}

async function newSession(rt: SessionRuntime): Promise<string> {
  const s = await rt.create({
    workspaceRoot: ws, cwd: ws, provider: 'anthropic', model: 'claude-test',
    credential: { provider: 'anthropic', id: 't' } as unknown as CredentialRef,
  })
  return s.sessionId
}

const exists = (p: string) => stat(p).then(() => true, () => false)

beforeEach(async () => {
  ws = await realpath(await mkdtemp(join(tmpdir(), 'agt-h4-ws-')))
  dataDir = await mkdtemp(join(tmpdir(), 'agt-h4-data-'))
  await writeFile(join(ws, 'hello.ts'), ORIGINAL)
  events = []
  openAll()
})

afterEach(async () => {
  await native.dispose()
  store.close()
  await rm(ws, { recursive: true, force: true })
  await rm(dataDir, { recursive: true, force: true })
})

/** Run 1 creates `notes.txt`; run 2 reads and patches `hello.ts`. Both writes asked and allowed. */
async function twoRuns(asker: PersonAsker): Promise<{ rt: SessionRuntime; sessionId: string }> {
  const client = scriptedClient([
    [use('w1', 'file__write', { path: 'notes.txt', content: 'one\n' })], done,
    [use('r1', 'file__read', { path: 'hello.ts' })], [use('p1', 'file__patch', { patch: PATCH })], done,
  ])
  const rt = runtimeWith(client, asker)
  const sessionId = await newSession(rt)
  expect((await rt.run(sessionId, 'write notes')).ok).toBe(true)
  expect((await rt.run(sessionId, 'patch hello')).ok).toBe(true)
  expect(await readFile(join(ws, 'hello.ts'), 'utf8')).toBe(PATCHED)
  expect(await readFile(join(ws, 'notes.txt'), 'utf8')).toBe('one\n')
  return { rt, sessionId }
}

describe('SessionRuntime.undo — the last change set, then the one before it', () => {
  test('reverts the last turn, asks through the policy, walks back, then has nothing left', async () => {
    const asker = person([allowOnce, allowOnce, allowOnce, allowOnce])
    const { rt, sessionId } = await twoRuns(asker)
    const askedBefore = asker.asked.length

    const first = await rt.undo(sessionId)
    expect(first.status).toBe('done')
    if (first.status !== 'done') return
    expect(first.lastTurn).toBe(true)
    expect(first.restored).toEqual([join(ws, 'hello.ts')])
    expect(first.kept).toEqual([])
    expect(first.sentence).toContain(UNDO_SCOPE_SENTENCE)
    expect(await readFile(join(ws, 'hello.ts'), 'utf8')).toBe(ORIGINAL)
    expect(await readFile(join(ws, 'notes.txt'), 'utf8')).toBe('one\n') // the earlier turn is untouched

    // The undo is a write: the default class ASKED the person, naming the file.
    const q = asker.asked[askedBefore]!
    expect(q.kind).toBe('permission')
    expect(q.subjects).toEqual([{ action: 'write', path: join(ws, 'hello.ts'), op: 'overwrite' }])

    // The next undo reaches an EARLIER turn, so it asks for confirmation before writing anything.
    const second = await rt.undo(sessionId)
    expect(second.status).toBe('needs-confirmation')
    if (second.status !== 'needs-confirmation') return
    expect(second.lastTurn).toBe(false)
    expect(second.ready.map(r => [r.path, r.op])).toEqual([[join(ws, 'notes.txt'), 'delete']])
    expect(await exists(join(ws, 'notes.txt'))).toBe(true)

    const confirmed = await rt.undo(sessionId, { confirm: true })
    expect(confirmed.status).toBe('done')
    expect(await exists(join(ws, 'notes.txt'))).toBe(false)

    const none = await rt.undo(sessionId)
    expect(none.status).toBe('nothing')
  })

  test('the undo is journaled as a tool call naming paths — never the contents', async () => {
    const { rt, sessionId } = await twoRuns(person([allowOnce, allowOnce, allowOnce]))
    const from = events.length
    expect((await rt.undo(sessionId)).status).toBe('done')
    const undoEvents = events.slice(from)
    expect(undoEvents.map(e => e.type)).toEqual([
      'tool.requested', 'policy.requested', 'policy.approved', 'tool.approved', 'tool.completed',
    ])
    expect(undoEvents.every(e => e.sessionId === sessionId)).toBe(true)
    const requested = undoEvents[0]!.data as { name: string }
    expect(requested.name).toBe(UNDO_TOOL_NAME)
    const completed = undoEvents[4]!.data as { filesTouched?: string[] }
    expect(completed.filesTouched).toEqual([join(ws, 'hello.ts')])
    const wire = JSON.stringify(undoEvents)
    expect(wire).not.toContain('hello, undo')
    expect(wire).not.toContain("greeting = 'hello'")
  })

  test('survives a restart: a new store and a new runtime on the same files still undo', async () => {
    const { sessionId } = await twoRuns(person([allowOnce, allowOnce]))
    await native.dispose()
    store.close()
    openAll()
    const rt2 = runtimeWith(scriptedClient([]), person([allowOnce]))
    const r = await rt2.undo(sessionId)
    expect(r.status).toBe('done')
    expect(await readFile(join(ws, 'hello.ts'), 'utf8')).toBe(ORIGINAL)
  })

  test('the bodies live in the content store at 0600, and never in the session row', async () => {
    const { sessionId } = await twoRuns(person([allowOnce, allowOnce]))
    const rows = await store.latestUndoable(sessionId)
    expect(rows).toHaveLength(1)
    const row = rows[0]!
    expect(row.stored).toBe(true)
    expect(await content.get(row.before!.sha256)).toBe(ORIGINAL)
    const file = join(dataDir, 'content', row.before!.sha256.slice(0, 2), row.before!.sha256.slice(2, 4), row.before!.sha256)
    expect((await stat(file)).mode & 0o777).toBe(0o600)
    expect(JSON.stringify(await store.getSession(sessionId))).not.toContain('hello')
  })

  test('a file changed since is refused in a sentence; the rest is undone only once confirmed', async () => {
    // One run writes two files.
    const client = scriptedClient([
      [use('w1', 'file__write', { path: 'a.txt', content: 'agent a\n' })],
      [use('r1', 'file__read', { path: 'hello.ts' })], [use('p1', 'file__patch', { patch: PATCH })], done,
    ])
    const asker = person([allowOnce, allowOnce, allowOnce])
    const rt = runtimeWith(client, asker)
    const sessionId = await newSession(rt)
    expect((await rt.run(sessionId, 'two files')).ok).toBe(true)
    await writeFile(join(ws, 'a.txt'), 'the person edited this\n')

    const asked = await rt.undo(sessionId)
    expect(asked.status).toBe('needs-confirmation')
    if (asked.status !== 'needs-confirmation') return
    expect(asked.lastTurn).toBe(true)
    expect(asked.refused.map(r => [r.path, r.code])).toEqual([[join(ws, 'a.txt'), 'changed']])
    expect(asked.ready.map(r => r.path)).toEqual([join(ws, 'hello.ts')])
    expect(await readFile(join(ws, 'hello.ts'), 'utf8')).toBe(PATCHED) // nothing written yet

    const r = await rt.undo(sessionId, { confirm: true })
    expect(r.status).toBe('done')
    if (r.status !== 'done') return
    expect(r.restored).toEqual([join(ws, 'hello.ts')])
    expect(r.kept.map(k => k.path)).toEqual([join(ws, 'a.txt')])
    expect(await readFile(join(ws, 'a.txt'), 'utf8')).toBe('the person edited this\n')
    expect(await readFile(join(ws, 'hello.ts'), 'utf8')).toBe(ORIGINAL)
    // The change set is settled: nothing of it is offered again.
    expect((await rt.undo(sessionId)).status).toBe('nothing')
  })

  test('a person who declines the write leaves every file and every checkpoint where it was', async () => {
    const { rt, sessionId } = await twoRuns(person([allowOnce, allowOnce, { answered: false, reason: 'cancelled' }]))
    const r = await rt.undo(sessionId)
    expect(r.status).toBe('denied')
    expect(await readFile(join(ws, 'hello.ts'), 'utf8')).toBe(PATCHED)
    expect(await store.latestUndoable(sessionId)).toHaveLength(1)
  })

  test('the floor binds: an undo can never write inside .git/, and nothing is marked undone', async () => {
    const rt = runtimeWith(scriptedClient([]), person([allowOnce]))
    const sessionId = await newSession(rt)
    const gitConfig = join(ws, '.git', 'config')
    await mkdir(join(ws, '.git'), { recursive: true })
    await writeFile(gitConfig, 'agent wrote this\n')
    // A checkpoint naming a floored path (a host added it to the floor after the write, or a record
    // written by a different policy): the undo must still be refused by the policy.
    const cp = createPersistentCheckpointStore(content, store)
    await cp.append({ path: gitConfig, before: 'original\n', after: 'agent wrote this\n', toolExecutionId: 'tx_fake', sessionId, runId: 'run_fake', at: '2026-09-29T12:00:00.000Z' })

    const r = await rt.undo(sessionId, { confirm: true })
    expect(r.status).toBe('denied')
    if (r.status !== 'denied') return
    expect(r.sentence).toContain('git-internals')
    expect(await readFile(gitConfig, 'utf8')).toBe('agent wrote this\n')
    expect(await store.latestUndoable(sessionId)).toHaveLength(1)
  })

  test('refused while a run of the session is in flight, and in words when there is no session', async () => {
    let release!: () => void
    const gate = new Promise<void>(r => { release = r })
    const slow: ProviderClient = {
      ...scriptedClient([]),
      async invokeOnce(req, attempt): Promise<InvocationResult> {
        await gate
        return scriptedClient([done]).invokeOnce(req, attempt)
      },
    }
    const rt = runtimeWith(slow, person())
    const sessionId = await newSession(rt)
    const running = rt.run(sessionId, 'think')
    await Bun.sleep(20)
    const r = await rt.undo(sessionId)
    expect(r).toMatchObject({ status: 'refused', reason: 'run-in-progress' })
    release()
    await running
    expect((await rt.undo('ses_nope')).status).toBe('refused')
  })
})

describe('undoLastChange — a body that could not be kept', () => {
  test('a write whose checkpoint body could not be stored is refused as unrecoverable', async () => {
    const failing: SessionContentStore = { async put() { return null }, async get() { return null } }
    const cp = createPersistentCheckpointStore(failing, store)
    const f = join(ws, 'lost.txt')
    await writeFile(f, 'after\n')
    await cp.append({ path: f, before: 'before\n', after: 'after\n', toolExecutionId: 'tx_1', sessionId: 'ses_x', runId: 'run_1', at: '2026-09-29T12:00:00.000Z' })
    const rows = await store.latestUndoable('ses_x')
    expect(rows[0]!.stored).toBe(false)

    const r = await undoLastChange('ses_x', {
      index: store, content, policy: createPolicy({ layers: [], home: '/home/nobody-h4' }),
      journal: null, runtimeVersion: 't', workspaceRoot: ws, cwd: ws, latestRunId: 'run_1',
    })
    expect(r.status).toBe('needs-confirmation')
    if (r.status !== 'needs-confirmation') return
    expect(r.refused).toEqual([{ path: f, code: 'unrecoverable', sentence: `${f} cannot be undone: its checkpoint could not be kept.` }])
    expect(r.ready).toEqual([])
  })
})
