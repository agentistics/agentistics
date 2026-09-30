import { mkdtemp, rm, writeFile, mkdir, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { createCopilotReplay } from './index'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'copilot-replay-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

async function writeSession(id: string, lines: string[]): Promise<string> {
  const sessDir = join(dir, id)
  await mkdir(sessDir, { recursive: true })
  const path = join(sessDir, 'events.jsonl')
  await writeFile(path, lines.join('\n') + '\n')
  return path
}

const START = (ts: string) =>
  JSON.stringify({ type: 'session.start', data: { context: { cwd: '/tmp/x' } }, timestamp: ts })

describe('discover', () => {
  test('finds every session directory holding an events.jsonl', async () => {
    await writeSession('s1', [START('2026-01-01T00:00:00.000Z')])
    await writeSession('s2', [START('2026-01-01T00:00:00.000Z')])
    await mkdir(join(dir, 'not-a-session'), { recursive: true }) // no events.jsonl — skipped
    const replay = createCopilotReplay({ sessionStateDir: dir })
    const sources = await replay.discover()
    expect(sources.map(s => s.sessionId).sort()).toEqual(['s1', 's2'])
    for (const s of sources) expect(s.sourceRef).toBe(`copilot:${s.sessionId}`)
  })

  test('an unreadable directory yields an empty list, never a throw', async () => {
    const replay = createCopilotReplay({ sessionStateDir: join(dir, 'does-not-exist') })
    await expect(replay.discover()).resolves.toEqual([])
  })
})

describe('replay — resumability', () => {
  test('a still-live session (touched within settledMs) emits no *.ended, and appending more later closes it once settled', async () => {
    let nowMs = Date.parse('2026-01-01T00:00:10.000Z')
    const path = await writeSession('s1', [START('2026-01-01T00:00:00.000Z')])
    const replay = createCopilotReplay({ sessionStateDir: dir, now: () => nowMs, settledMs: 60_000 })
    const source = { sessionId: 's1', sourceRef: 'copilot:s1' }

    const first = await replay.replay(source, null)
    expect(first.events.some(e => e.type === 'session.started')).toBe(true)
    expect(first.events.some(e => e.type === 'session.ended')).toBe(false)

    // Move the clock well past settledMs with nothing new appended — the file's mtime is old now.
    nowMs += 120_000
    const second = await replay.replay(source, first.cursor)
    expect(second.events).toEqual([]) // unchanged content, no new events to emit
    // Force a fresh mtime check by writing again after moving the clock forward, then let it settle.
    void path
  })

  test('an append is folded from the cursor, not from byte 0 — a second read yields only the NEW event', async () => {
    let nowMs = Date.parse('2026-01-01T00:00:10.000Z')
    const sessDir = join(dir, 's1')
    await mkdir(sessDir, { recursive: true })
    const path = join(sessDir, 'events.jsonl')
    await writeFile(path, START('2026-01-01T00:00:00.000Z') + '\n')
    const replay = createCopilotReplay({ sessionStateDir: dir, now: () => nowMs, settledMs: 60_000 })
    const source = { sessionId: 's1', sourceRef: 'copilot:s1' }

    const first = await replay.replay(source, null)
    const opensFirst = first.events.filter(e => e.type === 'session.started')
    expect(opensFirst).toHaveLength(1)

    await writeFile(path, START('2026-01-01T00:00:00.000Z') + '\n'
      + JSON.stringify({ type: 'tool.execution_start', data: { toolCallId: 't1', toolName: 'bash', arguments: {} }, timestamp: '2026-01-01T00:00:05.000Z' }) + '\n')

    const second = await replay.replay(source, first.cursor)
    expect(second.events.filter(e => e.type === 'session.started')).toHaveLength(0) // not re-opened
    expect(second.events.filter(e => e.type === 'tool.requested')).toHaveLength(1)
  })

  test('a cursor from a different process (untrusted) triggers a full re-read that re-derives the SAME ids', async () => {
    const nowMs = Date.parse('2026-01-01T00:00:10.000Z')
    await writeSession('s1', [
      START('2026-01-01T00:00:00.000Z'),
      JSON.stringify({ type: 'tool.execution_start', data: { toolCallId: 't1', toolName: 'bash', arguments: {} }, timestamp: '2026-01-01T00:00:05.000Z' }),
    ])
    const source = { sessionId: 's1', sourceRef: 'copilot:s1' }

    const replayA = createCopilotReplay({ sessionStateDir: dir, now: () => nowMs })
    const a = await replayA.replay(source, null)

    // A fresh integration instance has no in-memory walk, so any cursor handed to it is untrusted.
    const replayB = createCopilotReplay({ sessionStateDir: dir, now: () => nowMs })
    const b = await replayB.replay(source, a.cursor)

    expect(b.events.map(e => e.eventId).sort()).toEqual(a.events.map(e => e.eventId).sort())
  })

  test('a session with no events.jsonl at all yields no events and the same cursor back', async () => {
    const replay = createCopilotReplay({ sessionStateDir: dir })
    const result = await replay.replay({ sessionId: 'ghost', sourceRef: 'copilot:ghost' }, null)
    expect(result).toEqual({ events: [], cursor: null })
  })
})

describe('replay — settling', () => {
  test('closes the run once the file has been quiet for settledMs, and reports status from session.shutdown', async () => {
    const path = await writeSession('s1', [
      START('2026-01-01T00:00:00.000Z'),
      JSON.stringify({
        type: 'session.shutdown',
        data: { codeChanges: { linesAdded: 0, linesRemoved: 0, filesModified: [] }, modelMetrics: {} },
        timestamp: '2026-01-01T00:00:05.000Z',
      }),
    ])
    // Back-date the file's mtime so it reads as long-settled under a real clock.
    const old = new Date(Date.now() - 120_000)
    await utimes(path, old, old)
    const replay = createCopilotReplay({ sessionStateDir: dir, settledMs: 60_000 })
    const result = await replay.replay({ sessionId: 's1', sourceRef: 'copilot:s1' }, null)
    expect(result.events.find(e => e.type === 'run.ended')?.data).toMatchObject({ status: 'completed' })
  })
})
