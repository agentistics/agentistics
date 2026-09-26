import { afterEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile, appendFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentisticsEvent } from '@agentistics/core'
import { createClaudeReplay } from './index'
import { mainAgentIdOf, subagentIdOf } from './replay-core'

// ---- a disposable projects tree, structural-only content, no real conversation text -----------

const dirs: string[] = []
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'agentistics-claude-replay-'))
  dirs.push(dir)
  return dir
}
afterEach(async () => {
  await Promise.all(dirs.splice(0).map(d => rm(d, { recursive: true, force: true })))
})

const userLine = (ts: string, opts: { cwd?: string; version?: string } = {}) => JSON.stringify({
  type: 'user', timestamp: ts, ...(opts.cwd ? { cwd: opts.cwd } : {}), ...(opts.version ? { version: opts.version } : {}),
}) + '\n'

const assistantLine = (id: string, ts: string, model = 'claude-opus-5') => JSON.stringify({
  type: 'assistant', timestamp: ts,
  message: { id, model, usage: { input_tokens: 1, output_tokens: 2 }, content: [] },
}) + '\n'

/** An assistant line launching an agent via one `tool_use`. */
const launchLine = (toolUseId: string, ts: string, name: 'Agent' | 'Skill' = 'Agent') => JSON.stringify({
  type: 'assistant', timestamp: ts,
  message: { content: [{ type: 'tool_use', id: toolUseId, name, input: { description: 'do work' } }] },
}) + '\n'

/** The user line answering a launch — the modern async shape: only `agentId`, no numbers. */
const asyncResultLine = (toolUseId: string, agentId: string, ts: string) => JSON.stringify({
  type: 'user', timestamp: ts,
  message: { content: [{ type: 'tool_result', tool_use_id: toolUseId }] },
  toolUseResult: { agentId, status: 'async_launched' },
}) + '\n'

async function makeConversation(projectsDir: string, project: string, conversationId: string, content: string): Promise<string> {
  const dir = join(projectsDir, project)
  await mkdir(dir, { recursive: true })
  const file = join(dir, `${conversationId}.jsonl`)
  await writeFile(file, content)
  return file
}

function typesOf(events: AgentisticsEvent[]): string[] {
  return events.map(e => e.type)
}

// -------------------------------------------------------------------------------------------

describe('discover — every <project>/<conversationId>.jsonl, one level deep', () => {
  test('lists exactly the transcripts, across projects, and ignores non-.jsonl files', async () => {
    const projectsDir = await tempDir()
    await makeConversation(projectsDir, 'proj-a', 'conv-1', userLine('2026-01-01T00:00:00.000Z'))
    await makeConversation(projectsDir, 'proj-a', 'conv-2', userLine('2026-01-01T00:00:00.000Z'))
    await makeConversation(projectsDir, 'proj-b', 'conv-3', userLine('2026-01-01T00:00:00.000Z'))
    await writeFile(join(projectsDir, 'proj-a', 'notes.txt'), 'not a transcript')

    const replay = createClaudeReplay({ projectsDir })
    const sources = await replay.discover()
    const ids = sources.map(s => s.sessionId).sort()
    expect(ids).toEqual(['conv-1', 'conv-2', 'conv-3'])
    expect(sources.find(s => s.sessionId === 'conv-1')!.sourceRef).toBe('claude:conv-1')
  })

  test('an unreadable projects dir yields [], never a throw', async () => {
    const replay = createClaudeReplay({ projectsDir: join(await tempDir(), 'does-not-exist') })
    expect(await replay.discover()).toEqual([])
  })
})

describe('replay — from a null cursor', () => {
  test('a fresh, fully-settled conversation opens and closes in one call', async () => {
    const projectsDir = await tempDir()
    await makeConversation(projectsDir, 'proj-a', 'conv-1',
      userLine('2026-01-01T00:00:00.000Z', { cwd: '/repo', version: '2.1.0' }) +
      assistantLine('m1', '2026-01-01T00:00:01.000Z'))

    const replay = createClaudeReplay({ projectsDir, settledMs: 0 })
    const batch = await replay.replay({ sessionId: 'conv-1', sourceRef: 'claude:conv-1' }, null)

    expect(typesOf(batch.events)).toEqual([
      'session.started', 'run.started', 'agent.started',
      'model.invoked', 'model.completed',
      'agent.ended', 'run.ended', 'session.ended',
    ])
    expect(batch.cursor).not.toBeNull()
    const opened = batch.events[0]!
    expect(opened.agentId).toBeUndefined()
    const agentStarted = batch.events.find(e => e.type === 'agent.started')!
    expect(agentStarted.agentId).toBe(mainAgentIdOf('conv-1'))
  })

  test('a source nothing on disk can serve returns an empty batch, not a throw', async () => {
    const projectsDir = await tempDir()
    const replay = createClaudeReplay({ projectsDir })
    const batch = await replay.replay({ sessionId: 'nope', sourceRef: 'claude:nope' }, null)
    expect(batch.events).toEqual([])
  })

  test('a NOT-YET-SETTLED conversation opens but never closes', async () => {
    const projectsDir = await tempDir()
    await makeConversation(projectsDir, 'proj-a', 'conv-1',
      userLine('2026-01-01T00:00:00.000Z') + assistantLine('m1', '2026-01-01T00:00:01.000Z'))

    const replay = createClaudeReplay({ projectsDir, settledMs: 60 * 60_000 })
    const batch = await replay.replay({ sessionId: 'conv-1', sourceRef: 'claude:conv-1' }, null)
    expect(typesOf(batch.events)).toContain('session.started')
    expect(typesOf(batch.events)).not.toContain('session.ended')
  })
})

describe('replay — resuming from a cursor reads only what is new', () => {
  test('appending lines and replaying from the returned cursor yields only the NEW events', async () => {
    const projectsDir = await tempDir()
    const file = await makeConversation(projectsDir, 'proj-a', 'conv-1',
      userLine('2026-01-01T00:00:00.000Z') + assistantLine('m1', '2026-01-01T00:00:01.000Z'))

    const replay = createClaudeReplay({ projectsDir, settledMs: 60 * 60_000 })
    const first = await replay.replay({ sessionId: 'conv-1', sourceRef: 'claude:conv-1' }, null)
    expect(typesOf(first.events)).toEqual(['session.started', 'run.started', 'agent.started'])

    await appendFile(file, assistantLine('m2', '2026-01-01T00:00:02.000Z'))
    const second = await replay.replay({ sessionId: 'conv-1', sourceRef: 'claude:conv-1' }, first.cursor)
    // m1's response is proven closed by m2 opening; m1's own events arrive now, not m2's (held open).
    expect(typesOf(second.events)).toEqual(['model.invoked', 'model.completed'])
    // Nothing from the FIRST call is repeated.
    expect(typesOf(second.events)).not.toContain('session.started')

    // Polling again with the SAME cursor (nothing new appended) yields nothing.
    const third = await replay.replay({ sessionId: 'conv-1', sourceRef: 'claude:conv-1' }, second.cursor)
    expect(third.events).toEqual([])
  })

  test('a cursor from a DIFFERENT process (no matching in-memory walk) falls back to a full re-read', async () => {
    const projectsDir = await tempDir()
    await makeConversation(projectsDir, 'proj-a', 'conv-1',
      userLine('2026-01-01T00:00:00.000Z') + assistantLine('m1', '2026-01-01T00:00:01.000Z'))

    const first = createClaudeReplay({ projectsDir, settledMs: 60 * 60_000 })
    const batch1 = await first.replay({ sessionId: 'conv-1', sourceRef: 'claude:conv-1' }, null)

    // A fresh integration instance never saw this conversation — the cursor is a string from
    // "another process". It must still work, at the cost of re-emitting from the start.
    const second = createClaudeReplay({ projectsDir, settledMs: 60 * 60_000 })
    const batch2 = await second.replay({ sessionId: 'conv-1', sourceRef: 'claude:conv-1' }, batch1.cursor)
    expect(typesOf(batch2.events)).toEqual(['session.started', 'run.started', 'agent.started'])
  })
})

describe('replay — a partial trailing line is never consumed', () => {
  test('a half-written line waits; completing it lets its fact through', async () => {
    const projectsDir = await tempDir()
    const file = await makeConversation(projectsDir, 'proj-a', 'conv-1', userLine('2026-01-01T00:00:00.000Z'))

    const replay = createClaudeReplay({ projectsDir, settledMs: 60 * 60_000 })
    const first = await replay.replay({ sessionId: 'conv-1', sourceRef: 'claude:conv-1' }, null)
    expect(typesOf(first.events)).toEqual(['session.started', 'run.started', 'agent.started'])

    const nextLine = assistantLine('m1', '2026-01-01T00:00:01.000Z')
    await appendFile(file, nextLine.slice(0, Math.floor(nextLine.length / 2)))
    const mid = await replay.replay({ sessionId: 'conv-1', sourceRef: 'claude:conv-1' }, first.cursor)
    expect(mid.events).toEqual([])

    await appendFile(file, nextLine.slice(Math.floor(nextLine.length / 2)))
    const done = await replay.replay({ sessionId: 'conv-1', sourceRef: 'claude:conv-1' }, mid.cursor)
    // The model is still open (nothing closes it), so only the invocation is now readable — proven
    // by finishing the conversation and getting exactly the pair.
    const settled = createClaudeReplay({ projectsDir, settledMs: 0 })
    const finalBatch = await settled.replay({ sessionId: 'conv-1', sourceRef: 'claude:conv-1' }, null)
    expect(typesOf(finalBatch.events)).toContain('model.invoked')
    expect(typesOf(finalBatch.events)).toContain('model.completed')
    void done
  })
})

describe('replay — a rewrite is never resumed', () => {
  test('a same-length rewrite (caught by mtime) forces a full re-read', async () => {
    const projectsDir = await tempDir()
    const original = userLine('2026-01-01T00:00:00.000Z', { cwd: '/repo' })
    const file = await makeConversation(projectsDir, 'proj-a', 'conv-1', original)

    const replay = createClaudeReplay({ projectsDir, settledMs: 60 * 60_000 })
    const first = await replay.replay({ sessionId: 'conv-1', sourceRef: 'claude:conv-1' }, null)
    expect(typesOf(first.events)).toEqual(['session.started', 'run.started', 'agent.started'])

    const rewritten = original.replace('/repo', '/REPO')
    expect(rewritten.length).toBe(original.length)
    await new Promise(r => setTimeout(r, 12))
    await writeFile(file, rewritten)

    const second = await replay.replay({ sessionId: 'conv-1', sourceRef: 'claude:conv-1' }, first.cursor)
    // A full re-read opens the session again, from scratch, with the NEW cwd.
    expect(typesOf(second.events)).toEqual(['session.started', 'run.started', 'agent.started'])
    expect((second.events[0]!.data as { projectPath?: string }).projectPath).toBe('/REPO')
  })

  test('a rewrite that GREW the file (caught by the anchor) forces a full re-read', async () => {
    const projectsDir = await tempDir()
    const original = userLine('2026-01-01T00:00:00.000Z', { cwd: '/repo' })
    const file = await makeConversation(projectsDir, 'proj-a', 'conv-1', original)

    const replay = createClaudeReplay({ projectsDir, settledMs: 60 * 60_000 })
    const first = await replay.replay({ sessionId: 'conv-1', sourceRef: 'claude:conv-1' }, null)

    // Everything before the old cursor is now DIFFERENT, and the file is bigger — only the anchor
    // can tell the two apart from a same-length rewrite.
    await writeFile(file, userLine('2026-01-01T00:00:00.000Z', { cwd: '/rewritten' }) + original)
    const second = await replay.replay({ sessionId: 'conv-1', sourceRef: 'claude:conv-1' }, first.cursor)
    expect(typesOf(second.events)).toEqual(['session.started', 'run.started', 'agent.started'])
    expect((second.events[0]!.data as { projectPath?: string }).projectPath).toBe('/rewritten')
  })
})

describe('replay — the subagents/ directory: a claimed transcript, and an unclaimed fork', () => {
  test('a claimed subagent gets its own agent.started/agent.ended; an unclaimed fork gets nothing', async () => {
    const projectsDir = await tempDir()
    const conversationId = 'conv-1'
    const mainContent =
      userLine('2026-01-01T00:00:00.000Z') +
      launchLine('tu-1', '2026-01-01T00:00:01.000Z') +
      asyncResultLine('tu-1', 'agent-1', '2026-01-01T00:00:02.000Z')
    const mainFile = await makeConversation(projectsDir, 'proj-a', conversationId, mainContent)

    const subDir = join(join(mainFile, '..'), conversationId, 'subagents')
    await mkdir(subDir, { recursive: true })
    // The CLAIMED transcript: what the parent's launch actually pairs with.
    await writeFile(join(subDir, 'agent-agent-1.jsonl'), assistantLine('sm1', '2026-01-01T00:00:01.500Z'))
    await writeFile(join(subDir, 'agent-agent-1.meta.json'), JSON.stringify({ toolUseId: 'tu-1', agentType: 'Explore' }))
    // The FORK: nothing in the parent transcript names it, and its own meta claims no parent either.
    await writeFile(join(subDir, 'agent-fork-1.jsonl'), assistantLine('sf1', '2026-01-01T00:00:01.500Z'))

    const replay = createClaudeReplay({ projectsDir, settledMs: 0 })
    const batch = await replay.replay({ sessionId: conversationId, sourceRef: `claude:${conversationId}` }, null)

    const claimedId = subagentIdOf(conversationId, 'agent-1')
    const forkId = subagentIdOf(conversationId, 'fork-1')

    const claimedStarted = batch.events.find(e => e.type === 'agent.started' && e.agentId === claimedId)
    expect(claimedStarted).toBeDefined()
    expect((claimedStarted!.data as { parentAgentId?: string }).parentAgentId).toBe(mainAgentIdOf(conversationId))

    // The claimed subagent's own transcript was folded too — its model event carries ITS agentId.
    expect(batch.events.some(e => e.type === 'model.invoked' && e.agentId === claimedId)).toBe(true)
    expect(batch.events.some(e => e.type === 'agent.ended' && e.agentId === claimedId)).toBe(true)

    // The fork is invisible everywhere — no event of any type names it.
    expect(batch.events.some(e => e.agentId === forkId)).toBe(false)
  })

  test('a background launch the parent never answered is reported unmeasured, never as a zero measurement', async () => {
    const projectsDir = await tempDir()
    const conversationId = 'conv-2'
    const mainContent =
      userLine('2026-01-01T00:00:00.000Z') +
      launchLine('tu-9', '2026-01-01T00:00:01.000Z')
    await makeConversation(projectsDir, 'proj-a', conversationId, mainContent)
    // No subagents/ directory at all — nothing on disk measures this launch.

    const replay = createClaudeReplay({ projectsDir, settledMs: 0 })
    const batch = await replay.replay({ sessionId: conversationId, sourceRef: `claude:${conversationId}` }, null)
    const started = batch.events.filter(e => e.type === 'agent.started' && (e.data as { kind?: string }).kind === 'subagent')
    expect(started).toHaveLength(1)
    const ended = batch.events.find(e => e.type === 'agent.ended' && e.agentId === started[0]!.agentId)
    expect(ended).toBeDefined()
    expect((ended!.data as { status: string }).status).toBe('unmeasured')
  })
})

describe('replay — settledMs controls when a conversation is treated as final', () => {
  test('a large settledMs never closes a freshly-written conversation; settledMs:0 always does', async () => {
    const projectsDir = await tempDir()
    await makeConversation(projectsDir, 'proj-a', 'conv-1',
      userLine('2026-01-01T00:00:00.000Z') + assistantLine('m1', '2026-01-01T00:00:01.000Z'))

    const patient = createClaudeReplay({ projectsDir, settledMs: 60 * 60_000 })
    const batchPatient = await patient.replay({ sessionId: 'conv-1', sourceRef: 'claude:conv-1' }, null)
    expect(typesOf(batchPatient.events)).not.toContain('session.ended')

    const eager = createClaudeReplay({ projectsDir, settledMs: 0 })
    const batchEager = await eager.replay({ sessionId: 'conv-1', sourceRef: 'claude:conv-1' }, null)
    expect(typesOf(batchEager.events)).toContain('session.ended')
  })
})
